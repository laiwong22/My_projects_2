# Pong

A browser Pong game: you against the CPU, first to 7. It's plain HTML, CSS and JavaScript, with no build step and no dependencies.

## Play

- **Locally:** open `index.html` in any modern browser.
- **On the web (GitHub Pages):** in the repo, go to **Settings → Pages**, set the source to **Deploy from a branch** and pick the branch and `/ (root)`. The game will be at `https://<your-username>.github.io/<repo-name>/`.

Main menu → **Play** → choose **Easy / Medium / Hard**.

## Controls

| Action | Keys |
| --- | --- |
| Move paddle | `W`/`S` or `↑`/`↓`, or move the mouse / drag with a finger |
| Pause | `Esc` or `P` (or the pause button on screen) |
| Toggle sound | `M` |

The game pauses on its own if you switch tabs.

## How the smooth ball works

- **Fixed-timestep physics (240 Hz)**: the simulation runs at the same rate on every screen. Each frame draws the ball partway between the last two physics positions, so motion stays smooth at 60, 120 or 144 Hz.
- **Swept collision**: the game doesn't just move the ball and then check for overlap, which lets fast balls pass through paddles. It works out exactly when the ball will touch a wall or paddle during each step, bounces it at that moment, and uses the rest of the step after the bounce. At top speed the ball moves under 5 px per step, and a stress test of 5,000 max-speed shots had zero pass-throughs.
- Long frames (a hiccup or tab switch) are capped, so the ball never jumps ahead.

## Files

- `index.html`: page and menu screens
- `style.css`: layout and styling (scales to any screen, works on phones in landscape)
- `game.js`: game loop, physics, CPU player, input
