# Pickle Fever

A 3D pickleball-style take on Pong that runs in the browser: you against the CPU, first to 7. It's plain HTML, CSS and JavaScript, with no build step. The 3D view uses [three.js](https://threejs.org/), loaded from a CDN.

## Play

- **Locally:** open `index.html` in any modern browser (it needs an internet connection the first time, to load three.js).
- **On the web (GitHub Pages):** in the repo, go to **Settings → Pages**, set the source to **Deploy from a branch** and pick the branch and `/ (root)`. The game will be at `https://<your-username>.github.io/<repo-name>/`.

Main menu → **Play** → choose **Easy / Medium / Hard**.

## Controls

| Action | Keys |
| --- | --- |
| Move paddle | `W`/`S` or `↑`/`↓`, or move the mouse / drag with a finger |
| Pause | `Esc` or `P` (or the pause button on screen) |
| Toggle sound | `M` |

The game pauses on its own if you switch tabs.

## Rules and physics

- **The ball bounces.** Every shot clears the net and its first bounce lands in the opponent's court, between the kitchen line and the baseline. It then bounces up toward the other paddle.
- **Spin.** Move your paddle as you hit and the ball curves that way, and keeps curving a little after it bounces. Gentle movement adds little; a fast swipe with the mouse or a finger bends it a lot. An amber trail shows a spinning ball.
- **Out.** Only the sidelines (the long north and south edges) can be out. If a shot's first bounce lands past a sideline, the player who hit it loses the point. Without spin, a shot always lands inside the sidelines, so going out takes a wide shot with heavy outward spin.
- **Winning a point.** You win the point when the ball gets past the CPU's paddle, when its shot lands out, or when your shot lands in and curves off past a sideline before the CPU can reach it. The winner serves the next point, crosscourt like a real serve.

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
- `game.js`: game loop, physics, CPU player, input and the 3D scene
