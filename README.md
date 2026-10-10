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

## The look

- A black-and-white pickleball court with sidelines, baselines, the non-volley zone ("kitchen") 7 ft either side of the net, and centre service lines, scaled from a real 20 × 44 ft court.
- Pickleball paddles with a rounded face, edge guard and grip: yours is white with black trim, the CPU's black with white trim.
- An amber pickleball, holes and all, that arcs over the net with a shadow under it so you can always see where it is.

## How the smooth ball works

- **The game is simulated in 2D, viewed in 3D.** The physics works on a flat court seen from above; the 3D scene only draws it. The ball's height is worked out from its position along the court, so the arc is as smooth as the ball's movement.
- **Fixed-timestep physics (240 Hz)**: the simulation runs at the same rate on every screen. Each frame draws the ball partway between the last two physics positions, so motion stays smooth at 60, 120 or 144 Hz.
- **Swept collision**: the game doesn't just move the ball and then check for overlap, which lets fast balls pass through paddles. It works out exactly when the ball will touch a rail or paddle during each step, bounces it at that moment, and uses the rest of the step after the bounce. A stress test of 5,000 max-speed shots had zero pass-throughs.
- Long frames (a hiccup or tab switch) are capped, so the ball never jumps ahead.

## Files

- `index.html`: page, score display and menu screens
- `style.css`: layout and styling (scales to any screen, works on phones in landscape)
- `game.js`: game loop, physics, CPU player, input and the 3D scene
