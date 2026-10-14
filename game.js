(() => {
  'use strict';

  // ---- Constants (all in logical court units) ----
  // The court is simulated as seen from above: x runs from your baseline end
  // (left) to the CPU's (right), y runs across the court from the far
  // sideline (y = 0) to the near one (y = H), and z is height. The 3D scene
  // is only a view of that simulation.
  const W = 800;
  const H = 500;
  const PADDLE_W = 12;
  const PADDLE_H = 90;
  const PADDLE_MARGIN = 24;
  const BALL_R = 7;
  const WIN_SCORE = 11;

  // Physics runs at a fixed rate, independent of the display's refresh rate.
  // Rendering interpolates between the last two physics states, so motion is
  // smooth on 60/120/144 Hz screens alike.
  const STEP = 1 / 240;
  const MAX_FRAME = 0.1; // clamp long frames (tab switch, hiccup) to avoid a jump

  const PLAYER_SPEED = 620; // keyboard
  const POINTER_SPEED = 1600; // mouse/touch follow speed
  const MAX_HIT_ANGLE = (30 * Math.PI) / 180; // off the very edge of the paddle
  const MAX_AIM_SHIFT = 170; // how far across the court an edge hit aims the ball
  const CENTER_PULL = 0.35; // returns from wide positions drift back toward the middle
  const SERVE_DELAY = 1.0;
  const POINT_PAUSE = 0.9; // ball plays out briefly after a point is decided

  // Rally speed: steady for the first few hits, then every hit is faster.
  const RAMP_START = 4; // the 4th hit of a rally is the first faster one
  const RAMP = 1.08; // speed gained per hit after that
  const MAX_BALL_SPEED = 1150;

  // Ball flight
  const NET_CLEAR = 72; // height at which a shot crosses the net
  const MIN_GRAVITY = 300;
  const RESTITUTION = 0.72; // bounce height kept
  const BOUNCE_FRICTION = 0.96; // horizontal speed kept per bounce
  const LAND_MARGIN = 50; // un-spun shots land at least this far inside a sideline

  // Spin: moving the paddle as you hit puts sidespin on the ball. It swings
  // out against the spin, bends back across, then kicks off the bounce.
  const SPIN_REF = 1000; // paddle speed (units/s) that gives full spin
  const SPIN_MIN = 0.35; // below this fraction of SPIN_REF, no spin
  const MAX_CURVE = 360; // how far a full-spin shot bends in the air
  const CURVE_NET = 0.3; // share of that bend that moves where it lands
  const BOUNCE_KICK = 280; // sideways kick (units/s) off the first bounce at full spin
  const SPIN_AFTER_BOUNCE = 0.5; // share of the curve kept after each bounce

  // Smash: a fast, deep, low shot that skids off the court.
  const SMASH_WINDOW = 0.3; // seconds a smash stays ready after you press it
  const SMASH_COOLDOWN = 0.8;
  const SMASH_POWER = 1.45;
  const SMASH_MAX_SPEED = 1450;
  const SMASH_NET_CLEAR = 46;
  const SMASH_RESTITUTION = 0.55;

  const PADDLE_REACH = 50; // how far past a sideline a paddle can step
  const OFF_FIELD = 130; // a ball this far past a sideline after landing in is gone
  const REACH_MARGIN = 8; // spin never takes a ball further out than paddle reach minus this

  const DIFFICULTIES = {
    easy:   { cpuSpeed: 290, reaction: 0.22, error: 58, ballSpeed: 380, chaseOut: 0.35, smash: 0.03 },
    medium: { cpuSpeed: 430, reaction: 0.12, error: 40, ballSpeed: 450, chaseOut: 0.12, smash: 0.07 },
    hard:   { cpuSpeed: 620, reaction: 0.05, error: 27, ballSpeed: 520, chaseOut: 0, smash: 0.12 },
  };

  const PLAYER_FACE = PADDLE_MARGIN + PADDLE_W; // right edge of the player paddle
  const CPU_FACE = W - PADDLE_MARGIN - PADDLE_W; // left edge of the CPU paddle

  // Court markings, scaled from a real 20 × 44 ft pickleball court.
  const BASELINE = 60; // distance of each baseline from the end of the field
  const HALF_COURT = W / 2 - BASELINE; // 22 ft
  const KITCHEN = (HALF_COURT * 7) / 22; // non-volley zone is 7 ft deep
  const RUNOFF = 140; // visible ground beyond each sideline

  // 3D-only dimensions.
  const HIT_HEIGHT = 34; // paddle-centre height at rest, and the serve height
  const NET_HEIGHT = 30;
  const FACE_H = 60; // paddle face height

  // ---- DOM ----
  const canvas = document.getElementById('game');
  const screens = {
    menu: document.getElementById('screen-menu'),
    difficulty: document.getElementById('screen-difficulty'),
    controls: document.getElementById('screen-controls'),
    pause: document.getElementById('screen-pause'),
    over: document.getElementById('screen-over'),
    online: document.getElementById('screen-online'),
  };
  const pauseBtn = document.getElementById('pause-btn');
  const smashBtn = document.getElementById('smash-btn');
  const slider = document.getElementById('slider');
  const sliderThumb = document.getElementById('slider-thumb');
  const flashEl = document.getElementById('flash');
  const hud = {
    player: document.getElementById('score-player'),
    cpu: document.getElementById('score-cpu'),
    cpuLabel: document.getElementById('cpu-label'),
    callout: document.getElementById('callout'),
    rally: document.getElementById('rally'),
  };
  const touchDevice = window.matchMedia('(pointer: coarse)').matches;

  if (!window.THREE) {
    document.getElementById('menu-sub').textContent =
      'The 3D engine could not load. Check your internet connection and reload.';
    for (const b of document.querySelectorAll('[data-action="play"]')) b.disabled = true;
    return;
  }

  // ---- State ----
  const game = {
    mode: 'menu', // menu | playing | paused | over
    difficulty: 'medium',
    player: { y: (H - PADDLE_H) / 2, prevY: (H - PADDLE_H) / 2, vel: 0 },
    cpu: { y: (H - PADDLE_H) / 2, prevY: (H - PADDLE_H) / 2, vel: 0, target: H / 2, think: 0, aimError: 0, tracking: false, letGo: false },
    ball: {
      x: W / 2, y: H / 2, z: HIT_HEIGHT, vx: 0, vy: 0, vz: 0, ay: 0, g: MIN_GRAVITY, e: RESTITUTION,
      prevX: W / 2, prevY: H / 2, prevZ: HIT_HEIGHT,
      speed: 0, rallySpeed: 0, hits: 0, spin: 0, smash: false, kick: 0,
      bounced: false, bounces: 0, rolling: false, lastHitter: null,
    },
    score: { player: 0, cpu: 0 },
    server: 'player',
    serveTimer: 0,
    deadTimer: 0, // > 0 while a decided point plays out
    nextServer: 'player',
    timeScale: 1, // < 1 for slow motion on the winning point
    smashReady: 0, // > 0 while a smash is primed
    smashCooldown: 0,
  };

  const keys = new Set();
  let pointerY = null; // court y the paddle follows when using mouse/touch
  let muted = false;
  let usingKeyboard = false; // only auto-focus menu buttons for keyboard users

  // ---- Audio ----
  // Everything is synthesized with Web Audio: short noise bursts for the
  // paddle "pock" and impacts, tones for bounces, buzzers and chimes.
  let audio = null, master = null, noiseBuf = null;
  function ctx() {
    if (muted) return null;
    try {
      if (!audio) {
        audio = new (window.AudioContext || window.webkitAudioContext)();
        const comp = audio.createDynamicsCompressor();
        master = audio.createGain();
        master.gain.value = 0.8;
        master.connect(comp).connect(audio.destination);
        noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (audio.state === 'suspended') audio.resume();
      return audio;
    } catch (_) {
      return null; // audio unavailable; play silently
    }
  }

  function tone(f0, f1, dur, vol, type = 'sine', delay = 0) {
    const a = ctx();
    if (!a) return;
    const t = a.currentTime + delay;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(dur, vol, filter, f0, f1, q = 1, delay = 0) {
    const a = ctx();
    if (!a) return;
    const t = a.currentTime + delay;
    const src = a.createBufferSource();
    src.buffer = noiseBuf;
    const biquad = a.createBiquadFilter();
    biquad.type = filter;
    biquad.Q.value = q;
    biquad.frequency.setValueAtTime(f0, t);
    biquad.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const gain = a.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(biquad).connect(gain).connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  const sfx = {
    click: () => tone(900, 900, 0.03, 0.06, 'square'),
    hit(speedFrac) { // pickleball "pock", brighter as the rally speeds up
      noise(0.045, 0.6, 'bandpass', 1500 + speedFrac * 900, 900, 4);
      tone(560 + speedFrac * 320, 280, 0.08, 0.3, 'triangle');
    },
    spin: () => noise(0.3, 0.28, 'bandpass', 500, 2600, 2.5),
    smashReady: () => noise(0.12, 0.12, 'bandpass', 2600, 900, 2),
    smash() {
      noise(0.14, 0.9, 'highpass', 3000, 1200);
      tone(120, 36, 0.5, 0.8);
      tone(240, 60, 0.2, 0.3, 'square');
    },
    bounce(strength) {
      tone(180, 85, 0.07, 0.22 * strength);
      noise(0.03, 0.18 * strength, 'lowpass', 900, 300);
    },
    smashLand() {
      tone(85, 32, 0.4, 0.7);
      noise(0.25, 0.45, 'lowpass', 700, 90);
    },
    out() {
      tone(210, 210, 0.13, 0.22, 'square');
      tone(150, 150, 0.24, 0.22, 'square', 0.15);
    },
    pointWin() {
      tone(660, 660, 0.12, 0.25, 'triangle');
      tone(990, 990, 0.24, 0.25, 'triangle', 0.1);
    },
    pointLose() {
      tone(440, 440, 0.12, 0.2, 'triangle');
      tone(294, 294, 0.28, 0.2, 'triangle', 0.1);
    },
    rally: (level) => tone(380 + level * 40, 900 + level * 80, 0.28, 0.14, 'triangle'),
    matchPoint() {
      tone(95, 45, 0.2, 0.7);
      tone(95, 45, 0.3, 0.7, 'sine', 0.24);
    },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.3, 0.22, 'triangle', i * 0.12)),
    lose: () => [392, 330, 262].forEach((f, i) => tone(f, f * 0.98, 0.35, 0.2, 'triangle', i * 0.16)),
  };

  // ---- Screens ----
  function showScreen(name) {
    for (const [key, el] of Object.entries(screens)) el.classList.toggle('hidden', key !== name);
    pauseBtn.classList.toggle('hidden', name !== null || net.active);
    smashBtn.classList.toggle('hidden', name !== null || !touchDevice);
    slider.classList.toggle('hidden', name !== null || !touchDevice);
    const first = name && screens[name].querySelector('button');
    if (first && usingKeyboard) first.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function pulse(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the animation
    el.classList.add(cls);
  }

  function updateHud() {
    hud.player.textContent = game.score.player;
    hud.cpu.textContent = game.score.cpu;
    hud.cpuLabel.textContent = net.active ? 'FRIEND'
      : game.mode === 'menu' ? 'CPU' : 'CPU · ' + game.difficulty.toUpperCase();
  }

  function updateRally() {
    const n = game.ball.hits;
    hud.rally.textContent = n >= 3 ? `RALLY ${n}` : '';
    hud.rally.classList.toggle('hot', n >= RAMP_START);
  }

  function callout(text, accent = false) {
    hud.callout.textContent = text;
    hud.callout.classList.toggle('accent', accent);
    pulse(hud.callout, 'show');
  }

  function screenFlash(kind) {
    flashEl.className = '';
    void flashEl.offsetWidth;
    flashEl.className = 'show ' + kind;
  }

  function goToMenu() {
    game.mode = 'menu';
    resetRound('player');
    updateHud();
    showScreen('menu');
  }

  function startGame(difficulty, server = Math.random() < 0.5 ? 'player' : 'cpu') {
    game.difficulty = difficulty;
    game.score.player = 0;
    game.score.cpu = 0;
    game.player.y = game.player.prevY = (H - PADDLE_H) / 2;
    game.cpu.y = game.cpu.prevY = (H - PADDLE_H) / 2;
    pointerY = null;
    game.mode = 'playing';
    resetRound(server);
    accumulator = 0;
    updateHud();
    showScreen(null);
  }

  function pause() {
    if (game.mode !== 'playing' || net.active) return; // an online match can't be paused
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
    game.timeScale = 1;
    const won = game.score.player > game.score.cpu;
    document.getElementById('over-title').textContent = won ? 'You win!' : net.active ? 'Your friend wins' : 'CPU wins';
    document.getElementById('over-score').textContent = net.active
      ? `${game.score.player} – ${game.score.cpu}`
      : `${game.score.player} – ${game.score.cpu} on ${game.difficulty}`;
    document.getElementById('change-difficulty').classList.toggle('hidden', net.active);
    (won ? sfx.win : sfx.lose)();
    showScreen('over');
  }

  // ---- Rounds, serving and scoring ----
  function resetRound(server) {
    const b = game.ball;
    game.server = server;
    // Online, the receiver waits for the server's serve to arrive.
    game.serveTimer = net.active && server !== 'player' ? Infinity : SERVE_DELAY;
    game.deadTimer = 0;
    game.timeScale = 1;
    game.smashReady = 0;
    b.speed = 0;
    b.hits = 0;
    b.spin = 0;
    b.smash = false;
    b.ay = 0;
    b.rolling = false;
    b.bounced = false;
    b.bounces = 0;
    b.lastHitter = null;
    holdBall();
    b.prevX = b.x;
    b.prevY = b.y;
    b.prevZ = b.z;
    game.cpu.think = 0;
    game.cpu.tracking = false;
    net.held = 0;
    updateRally();

    const p = game.score.player, c = game.score.cpu;
    if (game.mode === 'playing' && Math.max(p, c) === WIN_SCORE - 1) {
      callout('MATCH POINT', true);
      sfx.matchPoint();
    }
  }

  // Before the serve, the ball sits just in front of the server's paddle.
  function holdBall() {
    const b = game.ball;
    const p = game.server === 'player' ? game.player : game.cpu;
    b.x = game.server === 'player' ? PLAYER_FACE + BALL_R + 1 : CPU_FACE - BALL_R - 1;
    b.y = Math.max(BALL_R, Math.min(H - BALL_R, p.y + PADDLE_H / 2));
    b.z = HIT_HEIGHT;
    b.vx = b.vy = b.vz = 0;
  }

  // Serves go crosscourt into the diagonal service court, like a real one.
  function serve() {
    const b = game.ball;
    const dir = game.server === 'player' ? 1 : -1;
    const landX = W / 2 + dir * (KITCHEN + (0.45 + 0.35 * Math.random()) * (HALF_COURT - KITCHEN));
    const landY = b.y < H / 2
      ? H / 2 + 40 + Math.random() * (H / 2 - 40 - LAND_MARGIN)
      : LAND_MARGIN + Math.random() * (H / 2 - 40 - LAND_MARGIN);
    b.rallySpeed = b.speed = DIFFICULTIES[game.difficulty].ballSpeed;
    b.spin = 0;
    b.smash = false;
    b.e = RESTITUTION;
    launch(dir, b.speed, landX, landY, 0, NET_CLEAR);
    b.lastHitter = game.server;
    sfx.hit(0);
    net.sendHit();
  }

  // Send the ball from where it is so that its first bounce lands exactly at
  // (landX, landY). `curve` is how far spin bends it sideways on the way:
  // the ball starts out aimed `curve` away from the landing spot and swings
  // onto it. Each shot gets its own gravity so it crosses the net at the
  // height asked for, whatever its speed.
  function launch(dir, xSpeed, landX, landY, curve, netClear) {
    const b = game.ball;
    const T = Math.abs(landX - b.x) / xSpeed;
    b.vx = dir * xSpeed;
    b.ay = (2 * curve) / (T * T);
    b.vy = (landY - curve - b.y) / T;

    const f = Math.min(0.9, Math.max(0.1, Math.abs(W / 2 - b.x) / Math.abs(landX - b.x)));
    const z0 = b.z - BALL_R;
    b.g = Math.max(MIN_GRAVITY, (2 * (netClear - z0 * (1 - f))) / (T * T * f * (1 - f)));
    b.vz = (0.5 * b.g * T * T - z0) / T;
    b.rolling = false;
    b.bounced = false;
    b.bounces = 0;
    b.kick = 0;
  }

  function hitBall(side, paddleY, paddleVel, smash) {
    const b = game.ball;
    const dir = side === 'player' ? 1 : -1;

    // Rally speed: steady at first, then every hit is faster.
    b.hits++;
    b.rallySpeed = Math.max(b.rallySpeed, DIFFICULTIES[game.difficulty].ballSpeed);
    if (b.hits >= RAMP_START) b.rallySpeed = Math.min(MAX_BALL_SPEED, b.rallySpeed * RAMP);
    const speed = smash ? Math.min(SMASH_MAX_SPEED, b.rallySpeed * SMASH_POWER) : b.rallySpeed;

    const rel = Math.max(-1, Math.min(1, (b.y - (paddleY + PADDLE_H / 2)) / (PADDLE_H / 2 + BALL_R)));
    const xSpeed = speed * Math.cos(rel * MAX_HIT_ANGLE);

    // Every return lands in the opponent's court, between the kitchen line
    // and the baseline (a smash goes deep). Where the paddle meets the ball
    // sets where it's aimed across the court, but without spin it always
    // lands inside the sidelines.
    const depth = smash ? 0.7 + 0.25 * Math.random() : 0.4 + 0.5 * Math.random();
    const landX = W / 2 + dir * (KITCHEN + depth * (HALF_COURT - KITCHEN));
    const aimY = Math.max(LAND_MARGIN, Math.min(H - LAND_MARGIN,
      b.y + (H / 2 - b.y) * CENTER_PULL + rel * MAX_AIM_SHIFT));

    // Spin bends the ball hard, but only part of that bend moves where it
    // lands: heavy outward spin on a wide shot is the only way to hit out.
    const s = Math.max(-1, Math.min(1, paddleVel / SPIN_REF));
    const spin = Math.sign(s) * Math.max(0, (Math.abs(s) - SPIN_MIN) / (1 - SPIN_MIN));
    const curve = spin * MAX_CURVE;

    b.speed = speed;
    b.spin = spin;
    b.smash = smash;
    b.e = smash ? SMASH_RESTITUTION : RESTITUTION;
    launch(dir, xSpeed, landX, aimY + curve * CURVE_NET, curve, smash ? SMASH_NET_CLEAR : NET_CLEAR);
    b.kick = reachableKick(dir, spin * BOUNCE_KICK);
    b.lastHitter = side;
    hitFeedback(side);
    if (side === 'player') net.sendHit();
  }

  // Sounds, effects and callouts for a hit, local or from the other player.
  function hitFeedback(side) {
    const b = game.ball;
    const dir = side === 'player' ? 1 : -1;
    const smash = b.smash, spin = b.spin;
    const speedFrac = speedFraction();
    fx.paddleFlash(side, smash ? 1.6 : 0.6 + speedFrac * 0.6);
    fx.sparks(b.x, b.y, b.z, dir, smash ? 46 : 10 + Math.round(speedFrac * 14), smash ? 520 : 260);
    if (smash) {
      fx.shake(11);
      sfx.smash();
      callout('SMASH!', true);
      screenFlash('smash');
    } else {
      sfx.hit(speedFrac);
      if (Math.abs(spin) >= 0.2) {
        sfx.spin();
        fx.shake(2 + Math.abs(spin) * 2);
        if (side === 'player') callout('SPIN', true);
      }
    }
    updateRally();
    if (b.hits === RAMP_START) {
      callout('SPEED UP', true);
      sfx.rally(0);
    } else if (b.hits > RAMP_START && b.hits % 3 === 0) {
      sfx.rally(Math.min(8, b.hits - RAMP_START));
    }
  }

  function speedFraction() {
    const b = game.ball;
    return Math.max(0, Math.min(1, (b.speed - 380) / (SMASH_MAX_SPEED - 380)));
  }

  // Award a point; the ball keeps flying for a moment before the next serve.
  function callPoint(winner, reason) {
    if (game.deadTimer > 0) return;
    game.score[winner]++;
    updateHud();
    pulse(winner === 'player' ? hud.player : hud.cpu, 'bump');
    const who = winner === 'player' ? 'YOU' : 'CPU';
    callout(reason ? `${reason} · POINT ${who}` : `POINT ${who}`, winner === 'player');
    if (reason) sfx.out();
    (winner === 'player' ? sfx.pointWin : sfx.pointLose)();
    screenFlash(winner === 'player' ? 'win' : 'lose');
    fx.shake(4);
    game.nextServer = winner;
    game.deadTimer = POINT_PAUSE;
    // The match-winning point plays out in slow motion.
    if (game.score[winner] >= WIN_SCORE) game.timeScale = 0.3;
  }

  // Online, whoever the ball is flying toward rules on that flight: they see
  // their own paddle exactly, so the call is always fair to the receiver.
  function awardPoint(winner, reason) {
    if (game.deadTimer > 0) return;
    if (net.active) {
      if (game.ball.vx >= 0) return; // the other player rules on this one
      net.send({ t: 'point', winner: winner === 'player' ? 'sender' : 'receiver', reason: reason || '' });
    }
    callPoint(winner, reason);
  }

  function finishPoint() {
    if (game.score.player >= WIN_SCORE || game.score.cpu >= WIN_SCORE) endGame();
    else resetRound(game.nextServer);
  }

  function triggerSmash() {
    if (game.mode !== 'playing' || game.smashCooldown > 0) return;
    game.smashReady = SMASH_WINDOW;
    game.smashCooldown = SMASH_COOLDOWN;
    sfx.smashReady();
  }

  // ---- Physics ----
  function clampPaddle(y) {
    return Math.max(-PADDLE_REACH, Math.min(H + PADDLE_REACH - PADDLE_H, y));
  }

  function updatePlayer(dt) {
    const p = game.player;
    const before = p.y;
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
    p.vel = (p.y - before) / dt;

    game.smashReady = Math.max(0, game.smashReady - dt);
    game.smashCooldown = Math.max(0, game.smashCooldown - dt);
  }

  // Move a ball state forward by t seconds. Returns true if it bounced.
  // Used both for the real ball and for the CPU's look-ahead.
  function advanceState(s, t) {
    s.x += s.vx * t;
    s.y += s.vy * t + 0.5 * s.ay * t * t;
    s.vy += s.ay * t;
    if (s.rolling) return false;
    s.z += s.vz * t - 0.5 * s.g * t * t;
    s.vz -= s.g * t;
    if (s.z < BALL_R && s.vz < 0) {
      s.z = BALL_R;
      s.vz = -s.vz * s.e;
      s.vx *= BOUNCE_FRICTION;
      s.vy *= BOUNCE_FRICTION;
      s.bounces++;
      if (s.bounces === 1) s.vy += s.kick; // sidespin kicks off the court
      s.ay *= SPIN_AFTER_BOUNCE;
      if (s.vz < 25) { s.vz = 0; s.rolling = true; }
      return true;
    }
    return false;
  }

  function advanceBall(t) {
    const b = game.ball;
    if (!advanceState(b, t)) return;

    const strength = Math.min(1, b.vz / 250 + 0.3);
    if (b.bounces === 1) {
      b.bounced = true;
      showLandingMark(b.x, b.y);
      if (b.smash) {
        sfx.smashLand();
        fx.shake(7);
        fx.shockwave(b.x, b.y);
        fx.dust(b.x, b.y, 30);
      } else {
        sfx.bounce(strength);
        fx.dust(b.x, b.y, 6);
      }
      // First bounce decides in or out; only the sidelines can be out.
      if (b.y < 0 || b.y > H) awardPoint(b.lastHitter === 'player' ? 'cpu' : 'player', 'OUT');
    } else {
      sfx.bounce(strength * 0.7);
      // Double-bounce rule: the receiver must hit it before it bounces twice.
      // (Once it's already past their paddle, it's simply a winner.)
      const beforePaddle = b.x - BALL_R >= PLAYER_FACE && b.x + BALL_R <= CPU_FACE;
      if (b.bounces === 2 && beforePaddle) awardPoint(b.lastHitter, 'DOUBLE BOUNCE');
    }
  }

  // Look ahead to where the ball will be when it reaches the CPU's paddle,
  // and whether its first bounce will land out.
  // The sideways kick a spinning ball takes off its first bounce, limited so
  // that when it reaches the receiver's paddle it is still within their
  // reach (at full stretch if need be). Spin bends the ball; it can't make a
  // ball that lands in impossible to return.
  const kickProbe = {};
  function reachableKick(dir, wanted) {
    const s = Object.assign(kickProbe, game.ball);
    s.kick = 0;
    let bounced = false;
    for (let i = 0; i < 2400 && !bounced; i++) bounced = advanceState(s, STEP);
    if (!bounced || s.y < 0 || s.y > H) return wanted; // lands out: the point is over anyway
    const lineX = dir > 0 ? CPU_FACE - BALL_R : PLAYER_FACE + BALL_R;
    const t = (lineX - s.x) / s.vx;
    if (!(t > 0)) return wanted;
    const drift = s.y + s.vy * t + 0.5 * s.ay * t * t; // where it arrives with no kick
    const lo = -PADDLE_REACH + REACH_MARGIN, hi = H + PADDLE_REACH - REACH_MARGIN;
    return Math.max((lo - drift) / t, Math.min((hi - drift) / t, wanted));
  }

  const lookahead = {};
  function predictForCpu() {
    const s = Object.assign(lookahead, game.ball);
    let landsOut = false;
    for (let i = 0; i < 600; i++) {
      if (advanceState(s, 1 / 120) && s.bounces === 1 && !game.ball.bounced) {
        landsOut = s.y < 0 || s.y > H;
      }
      if (s.x + BALL_R >= CPU_FACE) break;
    }
    return { y: s.y, landsOut };
  }

  function updateCpu(dt) {
    const c = game.cpu;
    const d = DIFFICULTIES[game.difficulty];
    const b = game.ball;
    const before = c.y;

    // Each time the ball heads its way, the CPU commits to one aiming error
    // (larger for faster balls) and decides whether to chase a ball that
    // looks like it's going out. It only re-plans every `reaction` seconds.
    const incoming = b.vx > 0 && game.serveTimer <= 0 && game.deadTimer <= 0;
    if (incoming && !c.tracking) {
      const speedFactor = b.speed / d.ballSpeed;
      c.aimError = (Math.random() * 2 - 1) * d.error * speedFactor;
      c.letGo = Math.random() >= d.chaseOut;
    }
    c.tracking = incoming;

    c.think -= dt;
    if (c.think <= 0) {
      c.think = d.reaction;
      if (incoming) {
        const p = predictForCpu();
        if (p.landsOut && !b.bounced && c.letGo) {
          // Step well clear of a ball that's going out, so it isn't played.
          const clear = p.y < H / 2 ? p.y + PADDLE_H * 1.3 : p.y - PADDLE_H * 1.3;
          c.target = Math.max(PADDLE_H / 2, Math.min(H - PADDLE_H / 2, clear));
        } else {
          c.target = p.y + c.aimError;
        }
      } else {
        c.target = H / 2 + (b.y - H / 2) * 0.3; // drift loosely toward centre
      }
    }

    const delta = c.target - (c.y + PADDLE_H / 2);
    const maxMove = d.cpuSpeed * dt;
    c.y = clampPaddle(c.y + Math.max(-maxMove, Math.min(maxMove, delta)));
    c.vel = (c.y - before) / dt;
  }

  // Continuous (swept) collision: instead of moving the ball and then
  // checking for overlap — which lets a fast ball skip through a paddle —
  // find the exact time within the step at which it first touches a paddle
  // face, move it there, hit it, and spend the rest of the step.
  function updateBall(dt) {
    const b = game.ball;
    let remaining = dt;

    // Online: when the ball reaches the other player's paddle and their paddle
    // looks to be in the way, wait there (briefly) for their hit to arrive
    // rather than flying on through and snapping back.
    if (net.active && b.vx > 0 && b.x + BALL_R >= CPU_FACE - 0.5) {
      const cy = game.cpu.y;
      const covered = b.y >= cy - BALL_R - 20 && b.y <= cy + PADDLE_H + BALL_R + 20;
      if (covered && net.held < 0.6) {
        net.held += dt;
        b.x = CPU_FACE - BALL_R;
        return;
      }
    }

    for (let i = 0; i < 3 && remaining > 1e-9; i++) {
      let hitT = Infinity;
      let hit = null;
      const yAt = (t) => b.y + b.vy * t + 0.5 * b.ay * t * t;

      // Paddle faces only count if the ball is still in front of them.
      if (b.vx < 0 && b.x - BALL_R >= PLAYER_FACE - 0.5) {
        const t = Math.max(0, (PLAYER_FACE + BALL_R - b.x) / b.vx);
        const y = yAt(t);
        const py = game.player.y;
        if (t <= remaining && y >= py - BALL_R && y <= py + PADDLE_H + BALL_R) { hitT = t; hit = 'player'; }
      } else if (b.vx > 0 && b.x + BALL_R <= CPU_FACE + 0.5 && !net.active) {
        const t = Math.max(0, (CPU_FACE - BALL_R - b.x) / b.vx);
        const y = yAt(t);
        const cy = game.cpu.y;
        if (t <= remaining && y >= cy - BALL_R && y <= cy + PADDLE_H + BALL_R) { hitT = t; hit = 'cpu'; }
      }

      if (hit === null) {
        advanceBall(remaining);
        break;
      }

      advanceBall(hitT);
      remaining -= hitT;
      if (game.deadTimer > 0) break; // the ball double-bounced on its way in
      if (hit === 'player') {
        b.x = PLAYER_FACE + BALL_R;
        const smash = game.smashReady > 0;
        game.smashReady = 0;
        hitBall('player', game.player.y, game.player.vel, smash);
      } else {
        b.x = CPU_FACE - BALL_R;
        const d = DIFFICULTIES[game.difficulty];
        hitBall('cpu', game.cpu.y, game.cpu.vel, b.z > 30 && Math.random() < d.smash);
      }
    }

    // A ball that gets past a paddle is the other side's point; one that
    // landed in and then ran off past a sideline beat the receiver.
    if (b.x + BALL_R < 0) awardPoint('cpu');
    else if (b.x - BALL_R > W) awardPoint('player');
    else if (b.bounced && (b.y < -OFF_FIELD || b.y > H + OFF_FIELD)) awardPoint(b.lastHitter);
  }

  function update(dt) {
    const b = game.ball;
    game.player.prevY = game.player.y;
    game.cpu.prevY = game.cpu.y;
    b.prevX = b.x;
    b.prevY = b.y;
    b.prevZ = b.z;

    updatePlayer(dt);
    if (net.active) updateRemote(dt);
    else updateCpu(dt);

    if (game.deadTimer > 0) {
      advanceBall(dt); // the point is decided; let the ball play out
      game.deadTimer -= dt;
      if (game.deadTimer <= 0) finishPoint();
      return;
    }
    if (game.serveTimer > 0) {
      holdBall();
      game.serveTimer -= dt;
      if (game.serveTimer <= 0) serve();
      return;
    }
    updateBall(dt);
  }


  // ---- Online play (peer to peer) ----
  // PeerJS's free public service introduces the two browsers; after that they
  // talk directly over WebRTC (or through PeerJS's free relay when a network
  // blocks direct connections). There is no game server. Each player
  // simulates the match from their own side, with themselves on the left, and
  // messages are mirrored on arrival. Whoever the ball is flying toward rules
  // on that flight: they decide hit or miss with their own paddle, then send
  // the ball's new state.
  const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
  const PEER_PREFIX = 'picklefever-';
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const WEBSITE = 'laiwong22.github.io/My_projects_2';
  const onlineStatus = document.getElementById('online-status');
  const onlineChoices = document.getElementById('online-choices');
  const onlineWait = document.getElementById('online-wait');
  const joinInput = document.getElementById('join-code');

  function loadPeerJs() {
    if (window.Peer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = PEERJS_URL;
      tag.onload = resolve;
      tag.onerror = reject;
      document.head.appendChild(tag);
    });
  }

  function showOnline(message) {
    onlineChoices.classList.remove('hidden');
    onlineWait.classList.add('hidden');
    onlineStatus.textContent = message || 'Create a game and send your friend the invite, or join with their code.';
    showScreen('online');
  }

  function onlineFailed(message) {
    net.leave();
    const elsewhere = location.hostname.endsWith('github.io') ? '' : ` Online play works on the website: ${WEBSITE}`;
    showOnline(message + elsewhere);
  }

  function peerError(err) {
    if (err && err.type === 'browser-incompatible') onlineFailed("This browser can't play online. Open the link in Safari or Chrome.");
    else onlineFailed("Couldn't reach the online service. Check your connection and try again.");
  }

  // Problems with the link to the PeerJS service that a reconnect can fix.
  const TRANSIENT = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']);

  const mirror = (s) => ({
    x: W - s.x, y: H - s.y, z: s.z, vx: -s.vx, vy: -s.vy, vz: s.vz, ay: -s.ay, g: s.g, e: s.e,
    speed: s.speed, rallySpeed: s.rallySpeed, hits: s.hits, spin: -s.spin, smash: s.smash, kick: -s.kick,
    bounces: s.bounces, bounced: s.bounced, rolling: s.rolling,
  });

  const net = {
    active: false, // an online match is on
    role: null, // 'host' | 'guest'
    peer: null,
    conn: null,
    code: null,
    latency: 0.05, // one-way, seconds
    held: 0, // how long the ball has waited at the other player's paddle
    oppTargetY: (H - PADDLE_H) / 2,
    lastSend: 0,
    lastPing: 0,
    lastHeard: 0, // when anything last arrived from the other player
    attempts: 0, // counts join attempts, so a stale retry can't touch a newer one
    joinCode: null,
    joinDeadline: 0,
    vis: { x: 0, y: 0, z: 0 }, // visual correction still being blended out

    send(msg) {
      if (net.conn && net.conn.open) {
        try { net.conn.send(msg); } catch (_) { /* connection dropping */ }
      }
    },

    // PeerJS's own STUN and relay servers, plus extra public STUN servers,
    // which help two phones on different networks find a route to each other.
    peerOptions() {
      return Object.assign({
        debug: 0,
        config: {
          iceServers: [
            { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
            { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
          ],
          sdpSemantics: 'unified-plan',
        },
      }, window.PEER_OPTIONS);
    },

    host() {
      net.leave();
      net.role = 'host';
      onlineStatus.textContent = 'Setting up…';
      loadPeerJs().then(() => {
        if (net.role !== 'host' || net.peer) return;
        const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
        const peer = new window.Peer(PEER_PREFIX + code.toLowerCase(), net.peerOptions());
        net.peer = peer;
        peer.on('open', () => {
          if (net.code) return; // reconnected after a drop; same code as before
          net.code = code;
          document.getElementById('room-code').textContent = code;
          document.getElementById('room-link').textContent = net.link();
          onlineChoices.classList.add('hidden');
          onlineWait.classList.remove('hidden');
          onlineStatus.textContent = 'Send your friend the invite, then come back to this screen. The match starts when they join.';
        });
        peer.on('connection', (conn) => {
          if (net.conn && net.conn.open) { // already playing someone
            conn.on('open', () => { conn.send({ t: 'busy' }); setTimeout(() => conn.close(), 300); });
            return;
          }
          if (net.conn) try { net.conn.close(); } catch (_) { /* replace a stalled attempt */ }
          net.attach(conn);
        });
        peer.on('error', (err) => {
          if (net.peer !== peer || net.active) return;
          if (err.type === 'unavailable-id' && !net.code) net.host(); // code taken; pick another
          else if (TRANSIENT.has(err.type) && net.code) { /* keep the room; we reconnect on our own */ }
          else peerError(err);
        });
      }).catch(() => onlineFailed("Couldn't load online play."));
    },

    // Joining keeps trying for a minute, so it still works if the host is
    // briefly away from the game (say, sending you the invite).
    join(raw) {
      const code = String(raw || '').trim().toUpperCase();
      if (code.length !== 5) {
        onlineStatus.textContent = 'Enter the 5-character code from your friend.';
        return;
      }
      net.leave();
      net.role = 'guest';
      net.joinCode = code;
      net.joinDeadline = performance.now() + 60000;
      const attempt = ++net.attempts;
      onlineStatus.textContent = `Joining ${code}…`;
      loadPeerJs().then(() => {
        if (net.attempts !== attempt || net.role !== 'guest') return;
        const peer = new window.Peer(net.peerOptions());
        net.peer = peer;
        let opened = false;
        peer.on('open', () => {
          if (opened) return; // reconnected after a drop; the retry loop carries on
          opened = true;
          net.connectTo(attempt);
        });
        peer.on('error', (err) => {
          if (net.attempts !== attempt || net.peer !== peer || net.active) return;
          if (err.type === 'peer-unavailable') {
            net.retryJoin(attempt, `Looking for game ${code}… Make sure your friend has the game open on the code screen.`);
          } else if (TRANSIENT.has(err.type) && opened) {
            /* we reconnect on our own and keep retrying */
          } else {
            peerError(err);
          }
        });
      }).catch(() => onlineFailed("Couldn't load online play."));
    },

    connectTo(attempt) {
      if (net.attempts !== attempt || net.active || !net.peer || net.peer.destroyed) return;
      if (net.peer.disconnected) { net.retryJoin(attempt); return; } // wait for the reconnect
      const conn = net.peer.connect(PEER_PREFIX + net.joinCode.toLowerCase(), { reliable: true });
      net.attach(conn);
      // An attempt that hasn't opened in 10 seconds is abandoned and retried.
      setTimeout(() => {
        if (net.attempts === attempt && net.conn === conn && !conn.open) {
          net.conn = null;
          try { conn.close(); } catch (_) { /* never opened */ }
          net.retryJoin(attempt);
        }
      }, 10000);
    },

    retryJoin(attempt, message) {
      if (net.attempts !== attempt || net.active || net.role !== 'guest') return;
      if (performance.now() > net.joinDeadline) {
        onlineFailed(`Couldn't connect to game ${net.joinCode}. Check the code, make sure your friend still has the game open, and try again.`);
        return;
      }
      if (message) onlineStatus.textContent = message;
      setTimeout(() => net.connectTo(attempt), 2500);
    },

    attach(conn) {
      net.conn = conn;
      conn.on('open', () => {
        if (net.conn !== conn) return;
        net.lastHeard = performance.now();
        onlineStatus.textContent = 'Connected. Starting…';
        if (net.role === 'host') net.rematch();
      });
      conn.on('data', (m) => { if (net.conn === conn) net.receive(m); });
      conn.on('close', () => net.closed(conn));
      conn.on('error', () => net.closed(conn));
    },

    closed(conn) {
      if (!net.conn || (conn && conn !== net.conn)) return;
      net.conn = null;
      if (net.active) {
        net.leave();
        game.mode = 'menu';
        showOnline('Your friend left the game.');
      } else if (net.role === 'guest') {
        net.retryJoin(net.attempts); // the host keeps waiting; the guest tries again
      }
    },

    leave() {
      if (net.conn && net.conn.open) try { net.conn.send({ t: 'bye' }); } catch (_) { /* closing anyway */ }
      const conn = net.conn, peer = net.peer;
      net.conn = null;
      net.peer = null;
      if (conn) try { conn.close(); } catch (_) { /* already closed */ }
      if (peer) try { peer.destroy(); } catch (_) { /* already gone */ }
      net.active = false;
      net.role = null;
      net.code = null;
      net.attempts++;
    },

    link() {
      return `${location.origin}${location.pathname}?join=${net.code}`;
    },

    invite() {
      const link = net.link();
      if (touchDevice && navigator.share) {
        navigator.share({ title: 'Pickle Fever', text: `Play Pickle Fever with me! Code ${net.code}`, url: link }).catch(() => {});
        return;
      }
      navigator.clipboard.writeText(link)
        .then(() => { onlineStatus.textContent = 'Invite link copied. Send it to your friend, then wait here.'; })
        .catch(() => {
          const range = document.createRange();
          range.selectNodeContents(document.getElementById('room-link'));
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          onlineStatus.textContent = 'Copy the link below and send it to your friend.';
        });
    },

    // The host starts every match and picks who serves first.
    rematch() {
      if (net.role === 'host') {
        const hostServes = Math.random() < 0.5;
        net.send({ t: 'start', server: hostServes ? 'sender' : 'receiver' });
        net.start(hostServes ? 'player' : 'cpu');
      } else {
        net.send({ t: 'rematch' });
        document.getElementById('over-score').textContent = 'Waiting for your friend…';
      }
    },

    start(server) {
      net.active = true;
      net.vis.x = net.vis.y = net.vis.z = 0;
      net.oppTargetY = (H - PADDLE_H) / 2;
      startGame('medium', server);
    },

    sendHit() {
      if (!net.active) return;
      const b = game.ball;
      net.send({ t: 'hit', b: {
        x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, ay: b.ay, g: b.g, e: b.e,
        speed: b.speed, rallySpeed: b.rallySpeed, hits: b.hits, spin: b.spin, smash: b.smash, kick: b.kick,
        bounces: b.bounces, bounced: b.bounced, rolling: b.rolling,
      } });
    },

    receive(m) {
      net.lastHeard = performance.now();
      switch (m.t) {
        case 'bye': net.closed(); break;
        case 'busy': onlineFailed('That game already has two players.'); break;
        case 'start': net.start(m.server === 'sender' ? 'cpu' : 'player'); break;
        case 'rematch': if (net.role === 'host' && game.mode === 'over') net.rematch(); break;
        case 'p': net.oppTargetY = H - m.y - PADDLE_H; break;
        case 'hit': net.receiveHit(m.b); break;
        case 'point':
          if (game.mode === 'playing') callPoint(m.winner === 'sender' ? 'cpu' : 'player', m.reason || undefined);
          break;
        case 'ping': net.send({ t: 'pong', s: m.s }); break;
        case 'pong': {
          const oneWay = Math.min(0.5, (performance.now() - m.s) / 2000);
          net.latency = net.latency * 0.7 + oneWay * 0.3;
          break;
        }
      }
    },

    receiveHit(state) {
      if (game.mode !== 'playing' || game.deadTimer > 0) return;
      const b = game.ball;
      const drawnX = b.x, drawnY = b.y, drawnZ = b.z;
      Object.assign(b, mirror(state));
      b.lastHitter = 'cpu';
      game.serveTimer = 0;
      net.held = 0;
      hitFeedback('cpu');
      // Catch up by the time the message spent travelling.
      for (let t = Math.min(0.3, net.latency); t >= STEP && game.deadTimer <= 0; t -= STEP) advanceBall(STEP);
      b.prevX = b.x;
      b.prevY = b.y;
      b.prevZ = b.z;
      // Draw the ball from where it was and let the difference fade out.
      const dx = drawnX - b.x, dy = drawnY - b.y, dz = drawnZ - b.z;
      if (Math.hypot(dx, dy, dz) < 250) {
        net.vis.x += dx;
        net.vis.y += dy;
        net.vis.z += dz;
      }
    },

    // Called every frame: share our paddle and check the connection.
    tick(now) {
      if (!net.active) return;
      // A closed tab or lost signal doesn't always close the connection, so
      // treat five seconds of silence as the other player having left.
      if (now - net.lastHeard > 5000) {
        net.closed();
        return;
      }
      if (now - net.lastSend > 33) {
        net.lastSend = now;
        net.send({ t: 'p', y: Math.round(game.player.y * 10) / 10 });
      }
      if (now - net.lastPing > 1000) {
        net.lastPing = now;
        net.send({ t: 'ping', s: now });
      }
    },
  };

  // The other player's paddle glides to where they last reported it.
  function updateRemote(dt) {
    const c = game.cpu;
    const before = c.y;
    c.y += (clampPaddle(net.oppTargetY) - c.y) * (1 - Math.exp(-dt * 30));
    c.vel = (c.y - before) / dt;
  }

  window.addEventListener('pagehide', () => net.leave());

  // Phones cut the link to the PeerJS service while the browser is in the
  // background. Reconnect (same code) every few seconds and on coming back.
  function reregister() {
    const p = net.peer;
    if (p && p.disconnected && !p.destroyed) try { p.reconnect(); } catch (_) { /* try again later */ }
  }
  setInterval(reregister, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reregister(); });

  document.getElementById('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    net.join(joinInput.value);
  });

  // ---- 3D scene ----
  // World axes: X along the court (court x − 400), Z across it (court y −
  // 250, positive toward the camera), Y up (court z).
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x050505);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x050505, 1400, 2600);

  const camera = new THREE.PerspectiveCamera(36, W / H, 10, 4000);
  const CAMERA_POS = new THREE.Vector3(0, 900, 600);
  const CAMERA_TARGET = new THREE.Vector3(0, 0, 25);
  camera.position.copy(CAMERA_POS);
  camera.lookAt(CAMERA_TARGET);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(-260, 700, 380);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -520, right: 520, top: 420, bottom: -420, near: 100, far: 1600 });
  sun.shadow.bias = -0.0008;
  scene.add(sun);

  const anisotropy = renderer.capabilities.getMaxAnisotropy();

  function canvasTexture(width, height, draw) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    draw(c.getContext('2d'), width, height);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = anisotropy;
    return tex;
  }

  // Court surface with pickleball markings plus run-off beyond the
  // sidelines, drawn at 2 px per court unit.
  const FIELD_H = H + 2 * RUNOFF;
  const courtTex = canvasTexture(1600, FIELD_H * 2, (g, cw) => {
    const s = cw / W;
    const Y = (y) => (y + RUNOFF) * s;
    g.fillStyle = '#161616'; // out of bounds
    g.fillRect(0, 0, cw, FIELD_H * s);
    g.fillStyle = '#0b0b0b'; // in bounds
    g.fillRect(BASELINE * s, Y(0), (W - 2 * BASELINE) * s, H * s);
    g.fillStyle = '#121212'; // kitchen (non-volley zone)
    g.fillRect((W / 2 - KITCHEN) * s, Y(0), KITCHEN * 2 * s, H * s);

    g.strokeStyle = '#f2f2f0';
    g.lineWidth = 3 * s;
    const line = (x1, y1, x2, y2) => {
      g.beginPath();
      g.moveTo(x1 * s, Y(y1));
      g.lineTo(x2 * s, Y(y2));
      g.stroke();
    };
    // Lines sit inside the court: a ball landing on a line is in.
    line(BASELINE, 1.5, W - BASELINE, 1.5); // sidelines
    line(BASELINE, H - 1.5, W - BASELINE, H - 1.5);
    line(BASELINE, 0, BASELINE, H); // baselines
    line(W - BASELINE, 0, W - BASELINE, H);
    line(W / 2 - KITCHEN, 0, W / 2 - KITCHEN, H); // kitchen lines
    line(W / 2 + KITCHEN, 0, W / 2 + KITCHEN, H);
    line(BASELINE, H / 2, W / 2 - KITCHEN, H / 2); // centre service lines
    line(W / 2 + KITCHEN, H / 2, W - BASELINE, H / 2);
    // Faint sideline extensions mark where "out" starts along the whole field.
    g.globalAlpha = 0.25;
    line(0, 1.5, BASELINE, 1.5);
    line(W - BASELINE, 1.5, W, 1.5);
    line(0, H - 1.5, BASELINE, H - 1.5);
    line(W - BASELINE, H - 1.5, W, H - 1.5);
  });

  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(W, FIELD_H),
    new THREE.MeshStandardMaterial({ map: courtTex, roughness: 0.9 })
  );
  court.rotation.x = -Math.PI / 2;
  court.receiveShadow = true;
  scene.add(court);

  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(3200, 2400),
    new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 })
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.5;
  apron.receiveShadow = true;
  scene.add(apron);

  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.55 });
  const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6 });

  // Net: mesh panel, white tape on top, posts just outside each sideline.
  const netTex = canvasTexture(256, 64, (g, cw, ch) => {
    g.clearRect(0, 0, cw, ch);
    g.strokeStyle = 'rgba(235, 235, 230, 0.55)';
    g.lineWidth = 1;
    for (let x = 0; x <= cw; x += 8) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, ch); g.stroke(); }
    for (let y = 0; y <= ch; y += 8) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(cw, y + 0.5); g.stroke(); }
  });
  netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;
  netTex.repeat.set(H / 64, NET_HEIGHT / 16);
  const netMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(H + 24, NET_HEIGHT),
    new THREE.MeshStandardMaterial({ map: netTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
  );
  netMesh.rotation.y = Math.PI / 2;
  netMesh.position.set(0, NET_HEIGHT / 2, 0);
  scene.add(netMesh);
  const tape = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3, H + 24), white);
  tape.position.set(0, NET_HEIGHT, 0);
  tape.castShadow = true;
  scene.add(tape);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, NET_HEIGHT + 4, 16), black);
    post.position.set(0, (NET_HEIGHT + 4) / 2, side * (H / 2 + 14));
    post.castShadow = true;
    scene.add(post);
  }

  // Pickleball paddle: rounded face, edge guard and grip. Built lying in the
  // XY plane (long side along X), then turned so the face looks at the net.
  function roundedRect(shape, w, h, r) {
    const x = -w / 2, y = -h / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r);
    shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    return shape;
  }

  function makePaddle(faceColor, trimMat, tilt) {
    const group = new THREE.Group();
    const r = 16;
    // Each face has its own material so it can flash when it hits.
    const faceMat = new THREE.MeshStandardMaterial({ color: faceColor, roughness: 0.55, emissive: 0xffb547, emissiveIntensity: 0 });

    const faceGeo = new THREE.ExtrudeGeometry(roundedRect(new THREE.Shape(), PADDLE_H - 4, FACE_H - 4, r - 2), {
      depth: 5, bevelEnabled: true, bevelThickness: 0.6, bevelSize: 0.6, bevelSegments: 2, curveSegments: 10,
    });
    faceGeo.translate(0, 0, -2.5);
    const face = new THREE.Mesh(faceGeo, faceMat);

    const guardShape = roundedRect(new THREE.Shape(), PADDLE_H, FACE_H, r);
    guardShape.holes.push(roundedRect(new THREE.Path(), PADDLE_H - 5, FACE_H - 5, r - 2.5));
    const guardGeo = new THREE.ExtrudeGeometry(guardShape, { depth: 7, bevelEnabled: false, curveSegments: 10 });
    guardGeo.translate(0, 0, -3.5);
    const guard = new THREE.Mesh(guardGeo, trimMat);

    // Grip sticks out of the near end of the face, toward the camera.
    const throat = new THREE.Mesh(new THREE.BoxGeometry(10, 12, 6), trimMat);
    throat.position.set(-PADDLE_H / 2 - 3, 0, 0);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.6, 30, 12), trimMat);
    grip.rotation.z = Math.PI / 2;
    grip.position.set(-PADDLE_H / 2 - 20, 0, 0);
    const butt = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.4, 3, 12), faceMat);
    butt.rotation.z = Math.PI / 2;
    butt.position.set(-PADDLE_H / 2 - 36, 0, 0);

    for (const m of [face, guard, throat, grip, butt]) {
      m.castShadow = true;
      group.add(m);
    }
    // Local X (long side) → world −Z, so the grip (local −X) points to +Z,
    // toward the camera; local Z (face normal) → world X, toward the net.
    group.rotation.y = Math.PI / 2;
    // Open the face up toward the camera, as a player would hold it.
    const holder = new THREE.Group();
    holder.rotation.z = tilt;
    holder.add(group);
    holder.userData.faceMat = faceMat;
    scene.add(holder);
    return holder;
  }

  const PADDLE_TILT = (35 * Math.PI) / 180;
  const playerPaddle = makePaddle(0xf2f2f0, black, PADDLE_TILT); // white face, black trim
  const cpuPaddle = makePaddle(0x141414, white, -PADDLE_TILT); // black face, white trim

  // Amber pickleball with its characteristic holes.
  const ballTex = canvasTexture(256, 128, (g, cw, ch) => {
    g.fillStyle = '#f5a83a';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#c47a12';
    for (let row = 0; row < 5; row++) {
      const y = (row + 0.5) * (ch / 5);
      const count = row === 2 ? 8 : 6;
      for (let i = 0; i < count; i++) {
        const x = ((i + (row % 2) * 0.5) / count) * cw;
        g.beginPath();
        g.ellipse(x, y, 7, 6, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
  const ballGeo = new THREE.SphereGeometry(BALL_R, 24, 16);
  const ballMat = new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.6, emissive: 0x5a3000, emissiveIntensity: 0.5 });
  const ball = new THREE.Mesh(ballGeo, ballMat);
  scene.add(ball);

  // The ball lights the court around it, brighter as it speeds up.
  const ballLight = new THREE.PointLight(0xffb547, 0, 240, 2);
  scene.add(ballLight);

  // Trail: fading amber ghosts behind a fast, spinning or smashed ball.
  const TRAIL = 12;
  const trail = [];
  for (let i = 0; i < TRAIL; i++) {
    const m = new THREE.Mesh(ballGeo, new THREE.MeshBasicMaterial({
      color: 0xffb547, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    m.scale.setScalar(1 - (0.65 * i) / TRAIL);
    m.visible = false;
    scene.add(m);
    trail.push(m);
  }
  const trailBuf = Array.from({ length: TRAIL * 2 }, () => new THREE.Vector3());
  let trailHead = 0, trailCount = 0;

  // Soft shadow right under the ball: shrinks and fades as the ball rises,
  // so you can always read its height and where it will land.
  const blobTex = canvasTexture(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.6)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false });
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(BALL_R * 4, BALL_R * 4), blobMat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.6;
  scene.add(blob);

  // Ring left on the court where a shot first lands; fades out.
  const markMat = new THREE.MeshBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0, depthWrite: false });
  const mark = new THREE.Mesh(new THREE.RingGeometry(BALL_R * 1.1, BALL_R * 1.7, 32), markMat);
  mark.rotation.x = -Math.PI / 2;
  mark.position.y = 0.8;
  scene.add(mark);
  let markAge = Infinity;
  function showLandingMark(x, y) {
    mark.position.x = x - W / 2;
    mark.position.z = y - H / 2;
    markAge = 0;
  }

  // ---- Effects ----
  // Sparks and dust share one particle pool; nothing is allocated per frame.
  const MAX_PARTICLES = 220;
  const pPos = new Float32Array(MAX_PARTICLES * 3);
  const pCol = new Float32Array(MAX_PARTICLES * 3);
  const pVel = new Float32Array(MAX_PARTICLES * 3);
  const pLife = new Float32Array(MAX_PARTICLES);
  const pMaxLife = new Float32Array(MAX_PARTICLES);
  const pBase = new Float32Array(MAX_PARTICLES * 3);
  const pGrav = new Float32Array(MAX_PARTICLES);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 4, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  particles.frustumCulled = false;
  scene.add(particles);
  let pNext = 0;

  function emit(x, y, z, vx, vy, vz, life, r, g, b, grav) {
    const i = pNext;
    pNext = (pNext + 1) % MAX_PARTICLES;
    pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
    pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
    pBase[i * 3] = r; pBase[i * 3 + 1] = g; pBase[i * 3 + 2] = b;
    pLife[i] = pMaxLife[i] = life;
    pGrav[i] = grav;
  }

  // Shockwave ring for smash landings.
  const waveMat = new THREE.MeshBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const wave = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), waveMat);
  wave.rotation.x = -Math.PI / 2;
  wave.position.y = 1;
  scene.add(wave);
  let waveAge = Infinity;

  let shakeAmp = 0;
  const flash = { player: 0, cpu: 0 };

  const fx = {
    shake(a) { shakeAmp = Math.max(shakeAmp, a); },
    paddleFlash(side, amount) { flash[side] = Math.max(flash[side], amount); },
    // Court (x, y, z) → world; sprays away from the paddle toward the net.
    sparks(x, y, z, dir, count, speed) {
      for (let i = 0; i < count; i++) {
        const a = (Math.random() - 0.5) * Math.PI;
        const v = speed * (0.4 + Math.random() * 0.6);
        const amber = Math.random() < 0.7;
        emit(x - W / 2, z, y - H / 2,
          dir * Math.cos(a) * v, Math.random() * v * 0.7, Math.sin(a) * v,
          0.25 + Math.random() * 0.35, 1, amber ? 0.71 : 1, amber ? 0.28 : 1, 600);
      }
    },
    dust(x, y, count) {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 40 + Math.random() * 120;
        emit(x - W / 2, 1, y - H / 2, Math.cos(a) * v, 20 + Math.random() * 60, Math.sin(a) * v,
          0.3 + Math.random() * 0.4, 0.55, 0.55, 0.52, 200);
      }
    },
    shockwave(x, y) {
      wave.position.x = x - W / 2;
      wave.position.z = y - H / 2;
      waveAge = 0;
    },
  };

  function updateEffects(dt, t) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt;
      const k = Math.max(0, pLife[i] / pMaxLife[i]);
      pVel[i * 3 + 1] -= pGrav[i] * dt;
      pPos[i * 3] += pVel[i * 3] * dt;
      pPos[i * 3 + 1] = Math.max(0.5, pPos[i * 3 + 1] + pVel[i * 3 + 1] * dt);
      pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
      pCol[i * 3] = pBase[i * 3] * k;
      pCol[i * 3 + 1] = pBase[i * 3 + 1] * k;
      pCol[i * 3 + 2] = pBase[i * 3 + 2] * k;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;

    waveAge += dt;
    if (waveAge < 0.55) {
      const k = waveAge / 0.55;
      wave.scale.setScalar(10 + k * 110);
      waveMat.opacity = 0.9 * (1 - k);
    } else {
      waveMat.opacity = 0;
    }

    // Camera shake: smooth wobble that dies away quickly.
    shakeAmp *= Math.exp(-dt * 7);
    camera.position.set(
      CAMERA_POS.x + Math.sin(t * 61) * shakeAmp,
      CAMERA_POS.y + Math.sin(t * 47 + 1) * shakeAmp * 0.6,
      CAMERA_POS.z + Math.sin(t * 53 + 2) * shakeAmp
    );
    camera.lookAt(CAMERA_TARGET);

    for (const side of ['player', 'cpu']) {
      flash[side] *= Math.exp(-dt * 8);
      (side === 'player' ? playerPaddle : cpuPaddle).userData.faceMat.emissiveIntensity = flash[side];
    }
    // A primed smash makes your paddle glow.
    if (game.smashReady > 0) playerPaddle.userData.faceMat.emissiveIntensity = Math.max(flash.player, 0.9);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  let lastBallX = W / 2, lastBallY = H / 2;
  const spinAxis = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const paddleLift = { player: HIT_HEIGHT, cpu: HIT_HEIGHT };

  // Paddles rise and dip to meet the ball as it comes to them.
  function paddleHeight(side, bx, bz, frameDt) {
    const b = game.ball;
    const coming = side === 'player' ? b.vx < 0 && bx < W / 2 : b.vx > 0 && bx > W / 2;
    const target = coming ? Math.max(14, Math.min(90, bz)) : HIT_HEIGHT;
    paddleLift[side] = lerp(paddleLift[side], target, 1 - Math.exp(-frameDt * 10));
    return paddleLift[side];
  }

  function render(alpha, frameDt, now) {
    const b = game.ball;
    const bx = lerp(b.prevX, b.x, alpha);
    const by = lerp(b.prevY, b.y, alpha);
    const bz = lerp(b.prevZ, b.z, alpha);
    const sceneDt = frameDt * game.timeScale;

    const py = lerp(game.player.prevY, game.player.y, alpha) + PADDLE_H / 2;
    const cy = lerp(game.cpu.prevY, game.cpu.y, alpha) + PADDLE_H / 2;
    playerPaddle.position.set(PLAYER_FACE - 4 - W / 2, paddleHeight('player', bx, bz, frameDt), py - H / 2);
    if (touchDevice) sliderThumb.style.top = `${(100 * (py - SLIDER_MIN)) / (SLIDER_MAX - SLIDER_MIN)}%`;
    cpuPaddle.position.set(CPU_FACE + 4 - W / 2, paddleHeight('cpu', bx, bz, frameDt), cy - H / 2);

    // Online corrections blend in over a moment instead of jumping.
    const k = Math.exp(-frameDt * 14);
    net.vis.x *= k; net.vis.y *= k; net.vis.z *= k;
    ball.position.set(bx - W / 2 + net.vis.x, bz + net.vis.z, by - H / 2 + net.vis.y);
    blob.position.x = ball.position.x;
    blob.position.z = ball.position.z;
    const lift = Math.min(1, (bz - BALL_R) / 160);
    blob.scale.setScalar(1 + lift * 0.8);
    blobMat.opacity = 1 - lift * 0.7;

    // Glow builds with speed.
    const live = game.mode === 'playing' && game.serveTimer <= 0;
    const speedFrac = live ? speedFraction() : 0;
    ballMat.emissiveIntensity = 0.5 + speedFrac * 1.1 + (b.smash ? 0.6 : 0);
    ballLight.position.copy(ball.position);
    ballLight.intensity = live ? 0.3 + speedFrac * 1.8 + (b.smash ? 1.2 : 0) : 0;

    // Roll the ball in its direction of travel, plus sidespin.
    const dx = bx - lastBallX, dz = by - lastBallY;
    const dist = Math.hypot(dx, dz);
    if (dist > 0 && dist < 50) {
      spinAxis.set(dz, 0, -dx).normalize();
      ball.rotateOnWorldAxis(spinAxis, dist / BALL_R);
    }
    if (b.spin) ball.rotateOnWorldAxis(UP, -b.spin * sceneDt * 40);
    lastBallX = bx;
    lastBallY = by;

    // Trail for spin, smashes and fast rallies.
    const trailStrength = live ? Math.max(Math.abs(b.spin) > 0.05 ? 0.6 : 0, b.smash ? 1 : 0, (speedFrac - 0.25) * 1.3) : 0;
    if (trailStrength > 0) {
      trailBuf[trailHead].copy(ball.position);
      trailHead = (trailHead + 1) % trailBuf.length;
      trailCount = Math.min(trailBuf.length, trailCount + 1);
    } else {
      trailCount = 0;
    }
    for (let i = 0; i < TRAIL; i++) {
      const back = (i + 1) * 2 - 1;
      const m = trail[i];
      m.visible = back < trailCount;
      if (!m.visible) continue;
      m.position.copy(trailBuf[(trailHead - 1 - back + trailBuf.length * 2) % trailBuf.length]);
      m.material.opacity = Math.min(1, trailStrength) * 0.45 * (1 - i / TRAIL);
    }

    markAge += sceneDt;
    markMat.opacity = markAge < 1.2 ? 0.9 * (1 - markAge / 1.2) : 0;

    updateEffects(sceneDt, now / 1000);
    renderer.render(scene, camera);
  }

  // ---- Main loop ----
  let last = performance.now();
  let accumulator = 0;

  function frame(now) {
    const dt = Math.min(MAX_FRAME, (now - last) / 1000);
    last = now;

    if (game.mode === 'playing') {
      accumulator += dt * game.timeScale;
      while (accumulator >= STEP && game.mode === 'playing') {
        update(STEP);
        accumulator -= STEP;
      }
    }

    net.tick(now);
    render(game.mode === 'playing' ? accumulator / STEP : 1, dt, now);
    requestAnimationFrame(frame);
  }

  // ---- Input ----
  const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Space', 'Tab']);

  window.addEventListener('pointerdown', () => { usingKeyboard = false; }, true);

  window.addEventListener('keydown', (e) => {
    usingKeyboard = true;
    if (e.target instanceof HTMLInputElement) return; // typing a game code
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
      if ((e.code === 'Tab' || e.code === 'Space') && !e.repeat) triggerSmash();
      else keys.add(e.code);
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

  // Map the pointer onto the court through the camera, so the paddle sits
  // right under your finger or cursor despite the perspective.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hitPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -HIT_HEIGHT);
  const hitPoint = new THREE.Vector3();
  function setPointer(e) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    // Aim with the steady camera, not the shaking one.
    camera.position.copy(CAMERA_POS);
    camera.lookAt(CAMERA_TARGET);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.ray.intersectPlane(hitPlane, hitPoint)) pointerY = hitPoint.z + H / 2;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (game.mode !== 'playing') return;
    if (e.pointerType === 'mouse' || e.buttons || e.pointerType === 'touch') setPointer(e);
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (game.mode !== 'playing') return;
    canvas.setPointerCapture(e.pointerId);
    setPointer(e);
    if (e.pointerType === 'mouse') triggerSmash(); // click to smash
  });

  pauseBtn.addEventListener('click', pause);

  // Phone slider: top of the track is the far sideline, bottom the near one,
  // covering the paddle's whole reach. The paddle follows at full touch speed,
  // so swiping the slider puts spin on the ball just like swiping the court.
  const SLIDER_MIN = -PADDLE_REACH + PADDLE_H / 2;
  const SLIDER_MAX = H + PADDLE_REACH - PADDLE_H / 2;
  function slide(e) {
    const rect = slider.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    pointerY = SLIDER_MIN + f * (SLIDER_MAX - SLIDER_MIN);
  }
  slider.addEventListener('pointerdown', (e) => {
    if (game.mode !== 'playing') return;
    e.preventDefault();
    slider.setPointerCapture(e.pointerId);
    slider.classList.add('active');
    slide(e);
  });
  slider.addEventListener('pointermove', (e) => {
    if (game.mode === 'playing' && slider.hasPointerCapture(e.pointerId)) slide(e);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    slider.addEventListener(type, () => slider.classList.remove('active'));
  }
  smashBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    triggerSmash();
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn === pauseBtn || btn === smashBtn) return;
    sfx.click();
    if (btn.dataset.difficulty) return startGame(btn.dataset.difficulty);
    switch (btn.dataset.action) {
      case 'play': net.leave(); game.mode = 'menu'; showScreen('difficulty'); break;
      case 'controls': showScreen('controls'); break;
      case 'menu': net.leave(); showScreen('menu'); break;
      case 'resume': resume(); break;
      case 'again': net.active ? net.rematch() : startGame(game.difficulty); break;
      case 'quit': net.leave(); goToMenu(); break;
      case 'online': showOnline(); break;
      case 'host': net.host(); break;
      case 'invite': net.invite(); break;
      case 'leave': net.leave(); showOnline(); break;
    }
  });

  window.addEventListener('resize', resize);

  // Small hook for automated tests / debugging in the console.
  window.__game = { game, update, STEP, DIFFICULTIES, setPointer: (y) => { pointerY = y; }, triggerSmash, hitBall, net };

  resize();
  updateHud();
  showScreen('menu');
  requestAnimationFrame(frame);

  // An invite link (…?join=CODE) goes straight to joining that game.
  const invited = new URLSearchParams(location.search).get('join');
  if (invited) {
    history.replaceState(null, '', location.pathname);
    joinInput.value = invited;
    showOnline();
    net.join(invited);
  }
})();
