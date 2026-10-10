(() => {
  'use strict';

  // ---- Constants (all in logical court units) ----
  // The game is simulated in 2D, as seen from above: x runs from your
  // baseline (left) to the CPU's (right), y runs across the court. The 3D
  // scene is only a view of that simulation, so the physics stays exact.
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

  // Court markings, scaled from a real 20 × 44 ft pickleball court.
  const BASELINE = 60; // distance of each baseline from the end of the field
  const HALF_COURT = W / 2 - BASELINE; // 22 ft
  const KITCHEN = (HALF_COURT * 7) / 22; // non-volley zone is 7 ft deep

  // 3D-only dimensions (visual height above the court).
  const HIT_HEIGHT = 34; // ball and paddle-centre height at contact
  const ARC_HEIGHT = 62; // extra height at the top of the arc, over the net
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
    player: { y: (H - PADDLE_H) / 2, prevY: (H - PADDLE_H) / 2 },
    cpu: { y: (H - PADDLE_H) / 2, prevY: (H - PADDLE_H) / 2, target: H / 2, think: 0, aimError: 0, tracking: false },
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, prevX: W / 2, prevY: H / 2, speed: 0 },
    score: { player: 0, cpu: 0 },
    serveTimer: 0,
    serveDir: 1,
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

  function goToMenu() {
    game.mode = 'menu';
    resetRound();
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
    game.serveDir = Math.random() < 0.5 ? -1 : 1;
    resetRound();
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
  // for bounces off the side rails?
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
    beep(dir > 0 ? 300 : 260, 0.05, 0.1, 'triangle'); // pickleball "pock"
  }

  // Continuous (swept) collision: instead of moving the ball and then
  // checking for overlap — which lets a fast ball skip through a paddle —
  // find the exact time within the step at which it first touches a rail or
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
        case 'top':    b.y = BALL_R;     b.vy = Math.abs(b.vy);  beep(200, 0.04, 0.05); break;
        case 'bottom': b.y = H - BALL_R; b.vy = -Math.abs(b.vy); beep(200, 0.04, 0.05); break;
        case 'player': b.x = PLAYER_FACE + BALL_R; bounceOffPaddle(game.player.y, b.y, 1); break;
        case 'cpu':    b.x = CPU_FACE - BALL_R;    bounceOffPaddle(game.cpu.y, b.y, -1); break;
      }
    }

    if (b.x + BALL_R < 0) pointScored('cpu');
    else if (b.x - BALL_R > W) pointScored('player');
  }

  function pointScored(who) {
    game.score[who]++;
    updateHud();
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

  // ---- 3D scene ----
  // World axes: X along the court (court x − 400), Z across it (court y −
  // 250, positive toward the camera), Y up.
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
  Object.assign(sun.shadow.camera, { left: -520, right: 520, top: 380, bottom: -380, near: 100, far: 1600 });
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

  // Court surface with pickleball markings, drawn at 2 px per court unit.
  const courtTex = canvasTexture(1600, 1000, (g, cw, ch) => {
    const s = cw / W;
    g.fillStyle = '#161616'; // out of bounds
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#0b0b0b'; // in bounds
    g.fillRect(BASELINE * s, 0, (W - 2 * BASELINE) * s, ch);
    g.fillStyle = '#121212'; // kitchen (non-volley zone)
    g.fillRect((W / 2 - KITCHEN) * s, 0, KITCHEN * 2 * s, ch);

    g.strokeStyle = '#f2f2f0';
    g.lineWidth = 3 * s;
    const line = (x1, y1, x2, y2) => {
      g.beginPath();
      g.moveTo(x1 * s, y1 * s);
      g.lineTo(x2 * s, y2 * s);
      g.stroke();
    };
    const e = 1.5; // keep edge lines fully on the texture
    line(BASELINE, e, W - BASELINE, e); // sidelines
    line(BASELINE, H - e, W - BASELINE, H - e);
    line(BASELINE, 0, BASELINE, H); // baselines
    line(W - BASELINE, 0, W - BASELINE, H);
    line(W / 2 - KITCHEN, 0, W / 2 - KITCHEN, H); // kitchen lines
    line(W / 2 + KITCHEN, 0, W / 2 + KITCHEN, H);
    line(BASELINE, H / 2, W / 2 - KITCHEN, H / 2); // centre service lines
    line(W / 2 + KITCHEN, H / 2, W - BASELINE, H / 2);
  });

  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
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

  // Side rails: the ball rebounds off these, so give them a physical form.
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(W, 10, 6), black);
    rail.position.set(0, 5, side * (H / 2 + 3));
    rail.castShadow = rail.receiveShadow = true;
    scene.add(rail);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(W, 1.5, 6.4), white);
    cap.position.set(0, 10.6, rail.position.z);
    scene.add(cap);
  }

  // Net: mesh panel, white tape on top, posts beyond each sideline.
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
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 24, 16),
    new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.6, emissive: 0x5a3000, emissiveIntensity: 0.5 })
  );
  scene.add(ball);

  // Contact shadow so the ball's position on the court reads even at the top
  // of its arc.
  const blobTex = canvasTexture(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(BALL_R * 4, BALL_R * 4),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.6;
  scene.add(blob);

  // Height of the ball above the court for a given court x: contact height at
  // either paddle, highest over the net. A pure function of x, so the arc is
  // as smooth as the ball's horizontal motion.
  function ballHeight(x) {
    const u = Math.max(-1, Math.min(1, (x - W / 2) / (CPU_FACE - BALL_R - W / 2)));
    return HIT_HEIGHT + ARC_HEIGHT * (1 - u * u);
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

  function render(alpha) {
    const py = lerp(game.player.prevY, game.player.y, alpha) + PADDLE_H / 2;
    const cy = lerp(game.cpu.prevY, game.cpu.y, alpha) + PADDLE_H / 2;
    playerPaddle.position.set(PLAYER_FACE - 4 - W / 2, HIT_HEIGHT, py - H / 2);
    cpuPaddle.position.set(CPU_FACE + 4 - W / 2, HIT_HEIGHT, cy - H / 2);

    const b = game.ball;
    const bx = lerp(b.prevX, b.x, alpha);
    const by = lerp(b.prevY, b.y, alpha);
    ball.position.set(bx - W / 2, ballHeight(bx), by - H / 2);
    blob.position.x = ball.position.x;
    blob.position.z = ball.position.z;

    // Roll the ball in its direction of travel.
    const dx = bx - lastBallX, dz = by - lastBallY;
    const dist = Math.hypot(dx, dz);
    if (dist > 0 && dist < 50) {
      spinAxis.set(dz, 0, -dx).normalize();
      ball.rotateOnWorldAxis(spinAxis, dist / BALL_R);
    }
    lastBallX = bx;
    lastBallY = by;

    const waiting = game.serveTimer > 0 && game.mode !== 'menu';
    ball.visible = blob.visible = !waiting || Math.floor(game.serveTimer * 6) % 2 === 0;

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
  window.__game = { game, update, STEP, DIFFICULTIES };

  resize();
  updateHud();
  showScreen('menu');
  requestAnimationFrame(frame);
})();
