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
  const MAX_HIT_ANGLE = (30 * Math.PI) / 180; // off the very edge of the paddle
  const MAX_AIM_SHIFT = 170; // how far across the court an edge hit aims the ball
  const CENTER_PULL = 0.35; // returns from wide positions drift back toward the middle
  const SERVE_DELAY = 1.0;
  const POINT_PAUSE = 0.9; // ball plays out briefly after a point is decided

  // Ball flight
  const NET_CLEAR = 72; // height at which a shot crosses the net
  const MIN_GRAVITY = 300;
  const RESTITUTION = 0.72; // bounce height kept
  const BOUNCE_FRICTION = 0.96; // horizontal speed kept per bounce
  const LAND_MARGIN = 50; // un-spun shots land at least this far inside a sideline

  // Spin: moving the paddle as you hit curves the ball that way.
  const SPIN_REF = 1000; // paddle speed (units/s) that gives full spin
  const SPIN_MIN = 0.4; // below this fraction of SPIN_REF, no spin
  const MAX_CURVE = 170; // sideways drift of a full-spin shot by its first bounce
  const SPIN_AFTER_BOUNCE = 0.5; // share of the curve kept after each bounce

  const PADDLE_REACH = 50; // how far past a sideline a paddle can step
  const OFF_FIELD = 130; // a ball this far past a sideline after landing in is gone

  const DIFFICULTIES = {
    easy:   { cpuSpeed: 290, reaction: 0.22, error: 58, ballSpeed: 380, chaseOut: 0.35 },
    medium: { cpuSpeed: 430, reaction: 0.12, error: 40, ballSpeed: 450, chaseOut: 0.12 },
    hard:   { cpuSpeed: 620, reaction: 0.05, error: 27, ballSpeed: 520, chaseOut: 0 },
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
  };
  const pauseBtn = document.getElementById('pause-btn');
  const hud = {
    player: document.getElementById('score-player'),
    cpu: document.getElementById('score-cpu'),
    cpuLabel: document.getElementById('cpu-label'),
    callout: document.getElementById('callout'),
  };

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
      x: W / 2, y: H / 2, z: HIT_HEIGHT, vx: 0, vy: 0, vz: 0, ay: 0, g: MIN_GRAVITY,
      prevX: W / 2, prevY: H / 2, prevZ: HIT_HEIGHT,
      speed: 0, spin: 0, bounced: false, rolling: false, lastHitter: null,
    },
    score: { player: 0, cpu: 0 },
    server: 'player',
    serveTimer: 0,
    deadTimer: 0, // > 0 while a decided point plays out
    nextServer: 'player',
  };

  const keys = new Set();
  let pointerY = null; // court y the paddle follows when using mouse/touch
  let muted = false;
  let usingKeyboard = false; // only auto-focus menu buttons for keyboard users

  // ---- Audio ----
  let audio = null;
  function beep(freq, duration = 0.06, volume = 0.08, type = 'square') {
    if (muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = type;
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

  function updateHud() {
    hud.player.textContent = game.score.player;
    hud.cpu.textContent = game.score.cpu;
    hud.cpuLabel.textContent = game.mode === 'menu' ? 'CPU' : 'CPU · ' + game.difficulty.toUpperCase();
  }

  function callout(text, accent = false) {
    const el = hud.callout;
    el.textContent = text;
    el.classList.toggle('accent', accent);
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
  }

  function goToMenu() {
    game.mode = 'menu';
    resetRound('player');
    updateHud();
    showScreen('menu');
  }

  function startGame(difficulty) {
    game.difficulty = difficulty;
    game.score.player = 0;
    game.score.cpu = 0;
    game.player.y = game.player.prevY = (H - PADDLE_H) / 2;
    game.cpu.y = game.cpu.prevY = (H - PADDLE_H) / 2;
    pointerY = null;
    resetRound(Math.random() < 0.5 ? 'player' : 'cpu');
    game.mode = 'playing';
    accumulator = 0;
    updateHud();
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

  // ---- Rounds, serving and scoring ----
  function resetRound(server) {
    const b = game.ball;
    game.server = server;
    game.serveTimer = SERVE_DELAY;
    game.deadTimer = 0;
    b.speed = 0;
    b.spin = 0;
    b.ay = 0;
    b.rolling = false;
    b.bounced = false;
    b.lastHitter = null;
    holdBall();
    b.prevX = b.x;
    b.prevY = b.y;
    b.prevZ = b.z;
    game.cpu.think = 0;
    game.cpu.tracking = false;
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
    b.speed = DIFFICULTIES[game.difficulty].ballSpeed;
    launch(dir, b.speed, landX, landY, 0);
    b.spin = 0;
    b.lastHitter = game.server;
    beep(300, 0.05, 0.1, 'triangle');
  }

  // Send the ball from where it is so that its first bounce lands exactly at
  // (landX, landY). `curve` is how far spin bends it sideways on the way:
  // the ball starts out aimed `curve` away from the landing spot and drifts
  // onto it. Each shot gets its own gravity so it crosses the net at a
  // consistent height whatever its speed.
  function launch(dir, xSpeed, landX, landY, curve) {
    const b = game.ball;
    const T = Math.abs(landX - b.x) / xSpeed;
    b.vx = dir * xSpeed;
    b.ay = (2 * curve) / (T * T);
    b.vy = (landY - curve - b.y) / T;

    const f = Math.min(0.9, Math.max(0.1, Math.abs(W / 2 - b.x) / Math.abs(landX - b.x)));
    const z0 = b.z - BALL_R;
    b.g = Math.max(MIN_GRAVITY, (2 * (NET_CLEAR - z0 * (1 - f))) / (T * T * f * (1 - f)));
    b.vz = (0.5 * b.g * T * T - z0) / T;
    b.rolling = false;
    b.bounced = false;
  }

  function hitBall(side, paddleY, paddleVel) {
    const b = game.ball;
    const dir = side === 'player' ? 1 : -1;
    const rel = Math.max(-1, Math.min(1, (b.y - (paddleY + PADDLE_H / 2)) / (PADDLE_H / 2 + BALL_R)));
    const angle = rel * MAX_HIT_ANGLE;
    b.speed = Math.min(MAX_BALL_SPEED, b.speed * SPEEDUP);
    const xSpeed = b.speed * Math.cos(angle);

    // Every return lands in the opponent's court, between the kitchen line
    // and the baseline. Where the paddle meets the ball sets where it's aimed
    // across the court, but without spin it always lands inside the sidelines.
    const landX = W / 2 + dir * (KITCHEN + (0.4 + 0.5 * Math.random()) * (HALF_COURT - KITCHEN));
    const aimY = Math.max(LAND_MARGIN, Math.min(H - LAND_MARGIN, b.y + (H / 2 - b.y) * CENTER_PULL + rel * MAX_AIM_SHIFT));

    // Spin can carry it past a sideline: that's the only way to hit out.
    const s = Math.max(-1, Math.min(1, paddleVel / SPIN_REF));
    const spin = Math.sign(s) * Math.max(0, (Math.abs(s) - SPIN_MIN) / (1 - SPIN_MIN));
    const curve = spin * MAX_CURVE;

    launch(dir, xSpeed, landX, aimY + curve, curve);
    b.spin = spin;
    b.lastHitter = side;

    beep(side === 'player' ? 300 : 260, 0.05, 0.1, 'triangle'); // pickleball "pock"
    if (side === 'player' && Math.abs(spin) >= 0.2) callout('SPIN', true);
  }

  // Award a point; the ball keeps flying for a moment before the next serve.
  function callPoint(winner, reason) {
    if (game.deadTimer > 0) return;
    game.score[winner]++;
    updateHud();
    const who = winner === 'player' ? 'YOU' : 'CPU';
    callout(reason ? `${reason} · POINT ${who}` : `POINT ${who}`);
    beep(winner === 'player' ? 660 : 220, 0.18, 0.09);
    game.nextServer = winner;
    game.deadTimer = POINT_PAUSE;
  }

  function finishPoint() {
    if (game.score.player >= WIN_SCORE || game.score.cpu >= WIN_SCORE) endGame();
    else resetRound(game.nextServer);
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
      s.vz = -s.vz * RESTITUTION;
      s.vx *= BOUNCE_FRICTION;
      s.vy *= BOUNCE_FRICTION;
      s.ay *= SPIN_AFTER_BOUNCE;
      if (s.vz < 25) { s.vz = 0; s.rolling = true; }
      return true;
    }
    return false;
  }

  function advanceBall(t) {
    const b = game.ball;
    if (!advanceState(b, t)) return;
    beep(150, 0.03, 0.06, 'triangle');
    if (!b.bounced) {
      b.bounced = true;
      showLandingMark(b.x, b.y);
      // First bounce decides in or out; only the sidelines can be out.
      if (b.y < 0 || b.y > H) callPoint(b.lastHitter === 'player' ? 'cpu' : 'player', 'OUT');
    }
  }

  // Look ahead to where the ball will be when it reaches the CPU's paddle,
  // and whether its first bounce will land out.
  const lookahead = {};
  function predictForCpu() {
    const s = Object.assign(lookahead, game.ball);
    let bounced = s.bounced;
    let landsOut = false;
    for (let i = 0; i < 600; i++) {
      if (advanceState(s, 1 / 120) && !bounced) {
        bounced = true;
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
      } else if (b.vx > 0 && b.x + BALL_R <= CPU_FACE + 0.5) {
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
      if (hit === 'player') {
        b.x = PLAYER_FACE + BALL_R;
        hitBall('player', game.player.y, game.player.vel);
      } else {
        b.x = CPU_FACE - BALL_R;
        hitBall('cpu', game.cpu.y, game.cpu.vel);
      }
    }

    // A ball that gets past a paddle is the other side's point; one that
    // landed in and then ran off past a sideline beat the receiver.
    if (b.x + BALL_R < 0) callPoint('cpu');
    else if (b.x - BALL_R > W) callPoint('player');
    else if (b.bounced && (b.y < -OFF_FIELD || b.y > H + OFF_FIELD)) callPoint(b.lastHitter);
  }

  function update(dt) {
    const b = game.ball;
    game.player.prevY = game.player.y;
    game.cpu.prevY = game.cpu.y;
    b.prevX = b.x;
    b.prevY = b.y;
    b.prevZ = b.z;

    updatePlayer(dt);
    updateCpu(dt);

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
  camera.position.set(0, 900, 600);
  camera.lookAt(0, 0, 25);

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
  const net = new THREE.Mesh(
    new THREE.PlaneGeometry(H + 24, NET_HEIGHT),
    new THREE.MeshStandardMaterial({ map: netTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
  );
  net.rotation.y = Math.PI / 2;
  net.position.set(0, NET_HEIGHT / 2, 0);
  scene.add(net);
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

  function makePaddle(faceMat, trimMat, tilt) {
    const group = new THREE.Group();
    const r = 16;

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
    scene.add(holder);
    return holder;
  }

  const PADDLE_TILT = (35 * Math.PI) / 180;
  const playerPaddle = makePaddle(white, black, PADDLE_TILT); // white face, black trim
  const cpuPaddle = makePaddle(black, white, -PADDLE_TILT); // black face, white trim

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
  const ball = new THREE.Mesh(
    ballGeo,
    new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.6, emissive: 0x5a3000, emissiveIntensity: 0.5 })
  );
  scene.add(ball);

  // Spin trail: fading amber ghosts behind a ball that's curving.
  const TRAIL = 10;
  const trail = [];
  for (let i = 0; i < TRAIL; i++) {
    const m = new THREE.Mesh(ballGeo, new THREE.MeshBasicMaterial({
      color: 0xffb547, transparent: true, opacity: 0.35 * (1 - i / TRAIL), depthWrite: false,
    }));
    m.scale.setScalar(1 - (0.6 * i) / TRAIL);
    m.visible = false;
    scene.add(m);
    trail.push(m);
  }
  const trailPoints = [];

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

  function render(alpha, frameDt) {
    const b = game.ball;
    const bx = lerp(b.prevX, b.x, alpha);
    const by = lerp(b.prevY, b.y, alpha);
    const bz = lerp(b.prevZ, b.z, alpha);

    const py = lerp(game.player.prevY, game.player.y, alpha) + PADDLE_H / 2;
    const cy = lerp(game.cpu.prevY, game.cpu.y, alpha) + PADDLE_H / 2;
    playerPaddle.position.set(PLAYER_FACE - 4 - W / 2, paddleHeight('player', bx, bz, frameDt), py - H / 2);
    cpuPaddle.position.set(CPU_FACE + 4 - W / 2, paddleHeight('cpu', bx, bz, frameDt), cy - H / 2);

    ball.position.set(bx - W / 2, bz, by - H / 2);
    blob.position.x = ball.position.x;
    blob.position.z = ball.position.z;
    const lift = Math.min(1, (bz - BALL_R) / 160);
    blob.scale.setScalar(1 + lift * 0.8);
    blobMat.opacity = 1 - lift * 0.7;

    // Roll the ball in its direction of travel, plus sidespin.
    const dx = bx - lastBallX, dz = by - lastBallY;
    const dist = Math.hypot(dx, dz);
    if (dist > 0 && dist < 50) {
      spinAxis.set(dz, 0, -dx).normalize();
      ball.rotateOnWorldAxis(spinAxis, dist / BALL_R);
    }
    if (b.spin) ball.rotateOnWorldAxis(UP, -b.spin * frameDt * 30);
    lastBallX = bx;
    lastBallY = by;

    // Spin trail
    const spinning = Math.abs(b.spin) > 0.05 && game.mode === 'playing' && game.serveTimer <= 0;
    if (spinning) {
      trailPoints.unshift(ball.position.clone());
      if (trailPoints.length > TRAIL * 2) trailPoints.length = TRAIL * 2;
    } else {
      trailPoints.length = 0;
    }
    for (let i = 0; i < TRAIL; i++) {
      const p = trailPoints[(i + 1) * 2 - 1];
      trail[i].visible = !!p;
      if (p) trail[i].position.copy(p);
    }

    markAge += frameDt;
    markMat.opacity = markAge < 1.2 ? 0.9 * (1 - markAge / 1.2) : 0;

    renderer.render(scene, camera);
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

    render(game.mode === 'playing' ? accumulator / STEP : 1, dt);
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

  // Map the pointer onto the court through the camera, so the paddle sits
  // right under your finger or cursor despite the perspective.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hitPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -HIT_HEIGHT);
  const hitPoint = new THREE.Vector3();
  function setPointer(e) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
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
  window.__game = { game, update, STEP, DIFFICULTIES, setPointer: (y) => { pointerY = y; } };

  resize();
  updateHud();
  showScreen('menu');
  requestAnimationFrame(frame);
})();
