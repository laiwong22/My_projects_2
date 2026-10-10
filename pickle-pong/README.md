# Pickle Pong

Pong played on a regulation-proportioned pickleball court (44 × 20 ft, 7 ft kitchens, 34"/36" net),
seen from above. Single self-contained file — open `index.html` in any modern browser.

## Rules
- Every shot must **bounce exactly once** on the receiver's side before being hit.
  - Hitting it in the air → **volley fault**.
  - Letting it bounce twice → **double bounce**, point to the hitter.
- First bounce out of bounds or a ball into the net → point to the opponent.
- Serves go diagonally from behind the baseline and must land past the kitchen line.
- Rally scoring; the winner of each rally serves. Game to 7 / 11 / 15 / 21, win by 2.

## Controls
| Action | Keys |
| --- | --- |
| Move | `WASD` / arrow keys, or drag on the court |
| Serve | `Space` or tap (hold `↑`/`↓` to aim) |
| Pause | `Esc` / `P` |
| Mute | `M` |

## Physics
- Ball has full 3D state (x, y, height) with gravity, ground bounces (restitution + friction) and a shadow to read its height.
- Where the ball meets the paddle sets the angle (classic Pong). Moving toward the net while hitting
  adds pace; fast flat shots get topspin so they dip over the net. Too much, and the ball sails long.
- Moving the paddle sideways at contact adds sidespin that curves the ball.

## Difficulty
Easy, Medium, Hard and Pro change the ball speed and the CPU's footspeed, reaction time, accuracy, aim and power.
An optional landing marker shows where the incoming ball will bounce.
