# Pickle Fever

A 3D pickleball-style take on Pong that runs in the browser: you against the CPU, first to 11. It's plain HTML, CSS and JavaScript, with no build step. The 3D view uses [three.js](https://threejs.org/), loaded from a CDN.

## Play

- **Locally:** open `index.html` in any modern browser (it needs an internet connection the first time, to load three.js).
- **On the web (GitHub Pages):** in the repo, go to **Settings → Pages**, set the source to **Deploy from a branch** and pick the branch and `/ (root)`. The game will be at `https://<your-username>.github.io/<repo-name>/`.

Main menu → **Play vs CPU** → choose **Easy / Medium / Hard**, or **Play a friend** to play someone online.

## Play a friend online

1. One player taps **Play a friend → Create game**. They get a 5-letter code and a **Send invite link** button.
2. The other player opens the invite link (or taps **Play a friend**, types the code and taps **Join**).
3. The match starts as soon as they connect. Each of you sees yourself on the left.

If the host steps away to send the invite, the game reconnects with the same code when they come back, and a friend who is joining keeps trying for up to a minute. Open the invite in Safari or Chrome; some in-app browsers (inside social apps) can't play online.

There is no game server. The two browsers connect directly to each other with WebRTC, using [PeerJS](https://peerjs.com/) (loaded from a CDN). PeerJS's free public service only introduces the two players, and its free relay steps in when a network blocks direct connections.

- Online play works on the website (GitHub Pages). It doesn't work inside the claude.ai page, which blocks these connections.
- Whoever the ball is flying toward decides hit or miss with their own paddle, so your hits always count exactly as you see them. Small network delays are blended out so the ball doesn't jump.
- An online match can't be paused. If either player closes the game or goes quiet for 5 seconds, the match ends.
- In the code, PeerJS settings can be overridden with `window.PEER_OPTIONS` (for example, to point at your own PeerJS server).

## Controls

| Action | Keys |
| --- | --- |
| Move paddle | `W`/`S` or `↑`/`↓`, move the mouse, drag on the court, or use the slider on the left on phones |
| Smash | `Tab` or `Space`, a mouse click, or the **SMASH** button on phones |
| Pause | `Esc` or `P` (or the pause button on screen) |
| Toggle sound | `M` |

The game pauses on its own if you switch tabs.

## Rules and physics

- **The ball bounces.** Every shot clears the net and its first bounce lands in the opponent's court, between the kitchen line and the baseline. It then bounces up toward the other paddle.
- **Spin.** Move your paddle as you hit to put sidespin on the ball: it swings out one way, bends back across in the direction you swiped, then kicks sideways off the bounce. Gentle movement adds a little; a fast swipe with the mouse or a finger bends it hard. An amber trail shows a spinning ball. However hard the spin, a ball that lands in always reaches the receiver within paddle reach, at full stretch if need be.
- **Smash.** Press smash just before the ball reaches you (your paddle glows while it's primed) for a fast, deep, low shot that skids off the court. The CPU smashes now and then too, more often on Hard.
- **Rally speed.** The first three hits of a rally stay at the starting speed; from the 4th hit on, every hit is faster, on every difficulty.
- **Double bounce.** If the ball bounces twice on your side before you hit it, you lose the point.
- **Out.** Only the sidelines (the long north and south edges) can be out. If a shot's first bounce lands past a sideline, the player who hit it loses the point. Without spin, a shot always lands inside the sidelines, so going out takes a wide shot with heavy outward spin.
- **Winning.** Games are first to 11.
- **Winning a point.** You win the point when the ball gets past the CPU's paddle, when its shot lands out, or when your shot lands in and curves off past a sideline before the CPU can reach it. The winner serves the next point, crosscourt like a real serve.

## Effects

Screen shake on smashes and points, sparks off the paddle, a shockwave where a smash lands, a ball that glows and lights the court as it speeds up, a speed trail, paddle flashes, and the match-winning point in slow motion. Sounds are synthesized to match: paddle pops that brighten as the rally speeds up, a whoosh for spin, a boom for smashes, buzzers for outs, and chimes for points.

## The look

- A black-and-white pickleball court with sidelines, baselines, the non-volley zone ("kitchen") 7 ft either side of the net, and centre service lines, scaled from a real 20 × 44 ft court.
- Pickleball paddles with a rounded face, edge guard and grip: yours is white with black trim, the CPU's black with white trim.
- An amber pickleball, holes and all, with a shadow under it that shrinks as it rises, and a ring where each shot lands.

## How the smooth ball works

- **Real ball flight.** The ball has height, gravity and bounces. Each shot is launched so its first bounce lands exactly where it was aimed, crossing the net at a consistent height whatever its speed.
- **Fixed-timestep physics (240 Hz)**: the simulation runs at the same rate on every screen. Each frame draws the ball partway between the last two physics positions, so motion stays smooth at 60, 120 or 144 Hz.
- **Swept collision**: the game doesn't just move the ball and then check for overlap, which lets fast balls pass through paddles. It works out exactly when the ball will touch a paddle during each step, including while it curves, bounces it at that moment, and uses the rest of the step after the bounce. A stress test of 5,000 max-speed curving shots had zero pass-throughs.
- Long frames (a hiccup or tab switch) are capped, so the ball never jumps ahead.

## Files

- `index.html`: page, score display and menu screens
- `style.css`: layout and styling (scales to any screen, works on phones in landscape)
- `game.js`: game loop, physics, CPU player, online play, input and the 3D scene
