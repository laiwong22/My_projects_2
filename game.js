(() => {
  'use strict';

  // ---- Constants (all in logical playfield units) ----
  const W = 800;
  const H = 500;
  const PADDLE_W = 12;
  const PADDLE_H = 90;
  const PADDLE_MARGIN = 24;
  const BALL_R = 7;
  const WIN_SCORE = 7;

  // Physics runs at a fixed rate, independent of the display's refresh rate.
  // Rendering interpolates between the last two physics states, so motion is
  // smooth on 60/120/144 Hz screens alike.
  const STEP = 1 / 240;
  const MAX_FRAME = 0.1; // clamp long frames (tab switch, hiccup) to avoid a jump

  const PLAYER_SPEED = 620; // keyboard
  const POINTER_SPEED = 1600; // mouse/touch follow speed
  const MAX_BALL_SPEED = 1150;
  const SPEEDUP = 1.05; // per paddle hit
  const MAX_BOUNCE_ANGLE = (55 * Math.PI) / 180;
  const SERVE_DELAY = 0.9;

  const DIFFICULTIES = {
    easy:   { cpuSpeed: 290, reaction: 0.22, error: 58, ballSpeed: 380 },
    medium: { cpuSpeed: 430, reaction: 0.12, error: 40, ballSpeed: 450 },
    hard:   { cpuSpeed: 620, reaction: 0.05, error: 27, ballSpeed: 520 },
  };

  const PLAYER_FACE = PADDLE_MARGIN + PADDLE_W; // right edge of the player paddle
  const CPU_FACE = W - PADDLE_MARGIN - PADDLE_W; // left edge of the CPU paddle

  // ---- DOM ----
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const screens = {
    menu: document.getElementById('screen-menu'),
    difficulty: document.getElementById('screen-difficulty'),
    controls: document.getElementById('screen-controls'),
    pause: document.getElementById('screen-pause'),
    over: document.getElementById('screen-over'),
  };
  const pauseBtn = document.getElementById('pause-btn');

  // ---- State ----
  const game = {
    mode: 'menu', // menu | playing | paused | over
    difficulty: 'medium',
    player: { y: (H - PADDLE_H) / 2, prevY: (H - PADDLE_H) / 2 },
    cpu: { y: (H - PADDLE_H) / 2, prevY: (H - PADDLE_H) / 2, target: H / 2, think: 0, aimError: 0, tracking: false },
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, prevX: W / 2, prevY: H / 2, speed: 0 },
    score: { player: 0, cpu: 0 },
    serveTimer: 0,
    serveDir: 1,
  };

  const keys = new Set();
  let pointerY = null; // logical y the paddle follows when using mouse/touch
  let muted = false;
  let usingKeyboard = false; // only auto-focus menu buttons for keyboard users

  // ---- Audio ----
  let audio = null;
  function beep(freq, duration = 0.06, volume = 0.08) {
    if (muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + duration);
    } catch (_) { /* audio unavailable; play silently */ }
  }

  // ---- Screens ----
  function showScreen(name) {
    for (const [key, el] of Object.entries(screens)) el.classList.toggle('hidden', key !== name);
    pauseBtn.classList.toggle('hidden', name !== null);
    const first = name && screens[name].querySelector('button');
    if (first && usingKeyboard) first.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function goToMenu() {
    game.mode = 'menu';
    resetRound();
    showScreen('menu');
  }

  function startGame(difficulty) {
    game.difficulty = difficulty;
    game.score.player = 0;
    game.score.cpu = 0;
    game.player.y = game.player.prevY = (H - PADDLE_H) / 2;
    game.cpu.y = game.cpu.prevY = (H - PADDLE_H) / 2;
    pointerY = null;
    game.serveDir = Math.random() < 0.5 ? -1 : 1;
    resetRound();
    game.mode = 'playing';
    accumulator = 0;
    showScreen(null);
  }

  function pause() {
    if (game.mode !== 'playing') return;
    game.mode = 'paused';
    keys.clear();
    showScreen('pause');
  }

  function resume() {
    if (game.mode !== 'paused') return;
    game.mode = 'playing';
    accumulator = 0;
    showScreen(null);
  }

  function endGame() {
    game.mode = 'over';
    const won = game.score.player > game.score.cpu;
    document.getElementById('over-title').textContent = won ? 'You win!' : 'CPU wins';
    document.getElementById('over-score').textContent =
      `${game.score.player} – ${game.score.cpu} on ${game.difficulty}`;
    beep(won ? 880 : 180, 0.35, 0.1);
    showScreen('over');
  }

  // ---- Round / serve ----
  function resetRound() {
    const b = game.ball;
    b.x = b.prevX = W / 2;
    b.y = b.prevY = H / 2;
    b.vx = b.vy = 0;
    b.speed = 0;
    game.serveTimer = SERVE_DELAY;
    game.cpu.think = 0;
    game.cpu.tracking = false;
  }

  function serve() {
    const b = game.ball;
    const angle = (Math.random() * 2 - 1) * (Math.PI / 6); // within ±30°
    b.speed = DIFFICULTIES[game.difficulty].ballSpeed;
    b.vx = Math.cos(angle) * b.speed * game.serveDir;
    b.vy = Math.sin(angle) * b.speed;
  }

  // ---- Physics ----
  function clampPaddle(y) {
    return Math.max(0, Math.min(H - PADDLE_H, y));
  }

  function updatePlayer(dt) {
    const p = game.player;
    const up = keys.has('ArrowUp') || keys.has('KeyW');
    const down = keys.has('ArrowDown') || keys.has('KeyS');
    const dir = (down ? 1 : 0) - (up ? 1 : 0);

    if (dir !== 0) {
      pointerY = null; // keyboard takes over
      p.y = clampPaddle(p.y + dir * PLAYER_SPEED * dt);
    } else if (pointerY !== null) {
      const delta = pointerY - PADDLE_H / 2 - p.y;
      const maxMove = POINTER_SPEED * dt;
      p.y = clampPaddle(p.y + Math.max(-maxMove, Math.min(maxMove, delta)));
    }
  }

  // Where will the ball's centre be when it reaches x = targetX, accounting
  // for bounces off the top and bottom walls?
  function predictY(targetX) {
    const b = game.ball;
    if (b.vx === 0) return b.y;
    const t = (targetX - b.x) / b.vx;
    if (t < 0) return b.y;
    const span = H - 2 * BALL_R;
    let y = b.y + b.vy * t - BALL_R;
    y = ((y % (2 * span)) + 2 * span) % (2 * span);
    if (y > span) y = 2 * span - y;
    return y + BALL_R;
  }

  function updateCpu(dt) {
    const c = game.cpu;
    const d = DIFFICULTIES[game.difficulty];
    const b = game.ball;

    // Each time the ball heads its way, the CPU commits to one aiming error,
    // larger for faster balls. It also only re-plans every `reaction` seconds.
    // Together these make it beatable, especially in fast rallies.
    const incoming = b.vx > 0;
    if (incoming && !c.tracking) {
      const speedFactor = b.speed / d.ballSpeed;
      c.aimError = (Math.random() * 2 - 1) * d.error * speedFactor;
    }
    c.tracking = incoming;

    c.think -= dt;
    if (c.think <= 0) {
      c.think = d.reaction;
      if (incoming) {
        c.target = predictY(CPU_FACE - BALL_R) + c.aimError;
      } else {
        c.target = H / 2 + (b.y - H / 2) * 0.3; // drift loosely toward centre
      }
    }

    const delta = c.target - (c.y + PADDLE_H / 2);
    const maxMove = d.cpuSpeed * dt;
    c.y = clampPaddle(c.y + Math.max(-maxMove, Math.min(maxMove, delta)));
  }

  function bounceOffPaddle(paddleY, hitY, dir) {
    const b = game.ball;
    const rel = (hitY - (paddleY + PADDLE_H / 2)) / (PADDLE_H / 2 + BALL_R);
    const angle = Math.max(-1, Math.min(1, rel)) * MAX_BOUNCE_ANGLE;
    b.speed = Math.min(MAX_BALL_SPEED, b.speed * SPEEDUP);
    b.vx = Math.cos(angle) * b.speed * dir;
    b.vy = Math.sin(angle) * b.speed;
    beep(dir > 0 ? 520 : 440);
  }

  // Continuous (swept) collision: instead of moving the ball and then
  // checking for overlap — which lets a fast ball skip through a paddle —
  // find the exact time within the step at which it first touches a wall or
  // paddle face, move it there, bounce, and spend the rest of the step.
  function updateBall(dt) {
    const b = game.ball;
    let remaining = dt;

    for (let i = 0; i < 4 && remaining > 1e-9; i++) {
      let hitT = Infinity;
      let hit = null;

      if (b.vy < 0) {
        const t = (BALL_R - b.y) / b.vy;
        if (t < hitT) { hitT = t; hit = 'top'; }
      } else if (b.vy > 0) {
        const t = (H - BALL_R - b.y) / b.vy;
        if (t < hitT) { hitT = t; hit = 'bottom'; }
      }

      // Paddle faces only count if the ball is still in front of them.
      if (b.vx < 0 && b.x - BALL_R >= PLAYER_FACE - 0.5) {
        const t = (PLAYER_FACE + BALL_R - b.x) / b.vx;
        if (t < hitT) {
          const yAt = b.y + b.vy * Math.max(0, t);
          const py = game.player.y;
          if (yAt >= py - BALL_R && yAt <= py + PADDLE_H + BALL_R) { hitT = t; hit = 'player'; }
        }
      } else if (b.vx > 0 && b.x + BALL_R <= CPU_FACE + 0.5) {
        const t = (CPU_FACE - BALL_R - b.x) / b.vx;
        if (t < hitT) {
          const yAt = b.y + b.vy * Math.max(0, t);
          const cy = game.cpu.y;
          if (yAt >= cy - BALL_R && yAt <= cy + PADDLE_H + BALL_R) { hitT = t; hit = 'cpu'; }
        }
      }

      if (hit === null || hitT > remaining) {
        b.x += b.vx * remaining;
        b.y += b.vy * remaining;
        break;
      }

      hitT = Math.max(0, hitT);
      b.x += b.vx * hitT;
      b.y += b.vy * hitT;
      remaining -= hitT;

      switch (hit) {
        case 'top':    b.y = BALL_R;     b.vy = Math.abs(b.vy);  beep(300, 0.04, 0.05); break;
        case 'bottom': b.y = H - BALL_R; b.vy = -Math.abs(b.vy); beep(300, 0.04, 0.05); break;
        case 'player': b.x = PLAYER_FACE + BALL_R; bounceOffPaddle(game.player.y, b.y, 1); break;
        case 'cpu':    b.x = CPU_FACE - BALL_R;    bounceOffPaddle(game.cpu.y, b.y, -1); break;
      }
    }

    if (b.x + BALL_R < 0) pointScored('cpu');
    else if (b.x - BALL_R > W) pointScored('player');
  }

  function pointScored(who) {
    game.score[who]++;
    beep(who === 'player' ? 660 : 220, 0.18, 0.09);
    if (game.score[who] >= WIN_SCORE) {
      endGame();
      return;
    }
    game.serveDir = who === 'player' ? 1 : -1; // serve toward whoever conceded
    resetRound();
  }

  function update(dt) {
    game.player.prevY = game.player.y;
    game.cpu.prevY = game.cpu.y;
    game.ball.prevX = game.ball.x;
    game.ball.prevY = game.ball.y;

    updatePlayer(dt);
    updateCpu(dt);

    if (game.serveTimer > 0) {
      game.serveTimer -= dt;
      if (game.serveTimer <= 0) serve();
      return;
    }
    updateBall(dt);
  }

  // ---- Rendering ----
  let scale = 1;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    scale = canvas.width / W;
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  function render(alpha) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, W, H);

    // Centre line
    ctx.fillStyle = 'rgba(232, 236, 244, 0.18)';
    for (let y = 8; y < H; y += 26) ctx.fillRect(W / 2 - 2, y, 4, 14);

    // Scores
    ctx.fillStyle = 'rgba(232, 236, 244, 0.35)';
    ctx.font = 'bold 64px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(String(game.score.player), W / 2 - 80, 24);
    ctx.fillText(String(game.score.cpu), W / 2 + 80, 24);

    if (game.mode === 'playing' || game.mode === 'paused') {
      ctx.font = '14px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = 'rgba(138, 147, 166, 0.7)';
      ctx.fillText('YOU', W / 2 - 80, 94);
      ctx.fillText('CPU · ' + game.difficulty.toUpperCase(), W / 2 + 80, 94);
    }

    // Paddles
    ctx.fillStyle = '#e8ecf4';
    ctx.fillRect(PADDLE_MARGIN, lerp(game.player.prevY, game.player.y, alpha), PADDLE_W, PADDLE_H);
    ctx.fillRect(CPU_FACE, lerp(game.cpu.prevY, game.cpu.y, alpha), PADDLE_W, PADDLE_H);

    // Ball (blinks gently while waiting to serve)
    const b = game.ball;
    const waiting = game.serveTimer > 0;
    if (!waiting || Math.floor(game.serveTimer * 6) % 2 === 0) {
      ctx.fillStyle = '#5ee6a8';
      ctx.shadowColor = 'rgba(94, 230, 168, 0.6)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(lerp(b.prevX, b.x, alpha), lerp(b.prevY, b.y, alpha), BALL_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // ---- Main loop ----
  let last = performance.now();
  let accumulator = 0;

  function frame(now) {
    const dt = Math.min(MAX_FRAME, (now - last) / 1000);
    last = now;

    if (game.mode === 'playing') {
      accumulator += dt;
      while (accumulator >= STEP && game.mode === 'playing') {
        update(STEP);
        accumulator -= STEP;
      }
    }

    render(game.mode === 'playing' ? accumulator / STEP : 1);
    requestAnimationFrame(frame);
  }

  // ---- Input ----
  const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Space']);

  window.addEventListener('pointerdown', () => { usingKeyboard = false; }, true);

  window.addEventListener('keydown', (e) => {
    usingKeyboard = true;
    if (e.code === 'KeyM') {
      muted = !muted;
      return;
    }
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (game.mode === 'playing') pause();
      else if (game.mode === 'paused') resume();
      return;
    }

    if (game.mode === 'playing') {
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      keys.add(e.code);
      return;
    }

    // Arrow-key navigation through menu buttons.
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const open = Object.values(screens).find((s) => !s.classList.contains('hidden'));
      if (!open) return;
      const buttons = [...open.querySelectorAll('button')];
      const i = buttons.indexOf(document.activeElement);
      const next = i < 0 ? (e.code === 'ArrowDown' ? 0 : -1) : e.code === 'ArrowDown' ? i + 1 : i - 1;
      buttons[(next + buttons.length) % buttons.length].focus();
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); pause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  function setPointer(e) {
    const rect = canvas.getBoundingClientRect();
    pointerY = ((e.clientY - rect.top) / rect.height) * H;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (game.mode !== 'playing') return;
    if (e.pointerType === 'mouse' || e.buttons || e.pointerType === 'touch') setPointer(e);
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (game.mode !== 'playing') return;
    canvas.setPointerCapture(e.pointerId);
    setPointer(e);
  });

  pauseBtn.addEventListener('click', pause);

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn === pauseBtn) return;
    beep(600, 0.03, 0.04);
    if (btn.dataset.difficulty) return startGame(btn.dataset.difficulty);
    switch (btn.dataset.action) {
      case 'play': game.mode = 'menu'; showScreen('difficulty'); break;
      case 'controls': showScreen('controls'); break;
      case 'menu': showScreen('menu'); break;
      case 'resume': resume(); break;
      case 'again': startGame(game.difficulty); break;
      case 'quit': goToMenu(); break;
    }
  });

  window.addEventListener('resize', resize);

  // Small hook for automated tests / debugging in the console.
  window.__pong = { game, update, STEP, DIFFICULTIES };

  resize();
  showScreen('menu');
  requestAnimationFrame(frame);
})();
