# NFL BLITZ - Arcade Edition

A browser-based clone of the classic NFL Blitz arcade game. Fast-paced 7-on-7 football with no penalties, 30 yards for a first down, and over-the-top action.

## How to Play

Open `index.html` in any modern browser, or serve with any static file server:

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Controls

| Action | Key |
|--------|-----|
| Move | WASD or Arrow Keys |
| Sprint | Shift |
| Snap Ball / Confirm | Space or Enter |
| Pass to Receiver | Click on receiver, or press 1-4 |
| Switch Player | E |
| Select Play | Left/Right + Enter, or press 1-4 |

## Gameplay

- **30 yards** for a first down (not 10!)
- **No penalties** - anything goes
- **7-on-7** simplified football
- **4 quarters**, 2 minutes each (accelerated clock)
- **Big hits** with screen shake and particle effects
- **Interceptions** can happen on passes
- **Turnovers on downs** after 4th down failure

## Game Flow

1. Press Enter/Space on the title screen
2. Select your team with arrows and confirm
3. Coin toss determines who receives
4. Pick your play (offense or defense)
5. Press Space to snap the ball
6. On offense: pass or run to score
7. On defense: tackle the ball carrier

## Tips

- On offense, wait for receivers to get open before passing
- Click directly on a receiver to target them
- Use sprint (Shift) for bursts of speed
- Press E to switch to the player closest to the action
- On defense, control the player nearest to the ball carrier
- Blitz defense is aggressive but leaves receivers open
- Run plays are safer but gain fewer yards

## Features

- Full game clock and scoring
- Play selection system (4 offensive, 4 defensive plays)
- CPU AI that runs routes, passes, and plays defense
- Touchdown celebrations with particles
- Screen shake on big hits
- Sound effects via Web Audio API
- Smooth camera tracking
- Speed trails on fast players
- First down and line of scrimmage markers
