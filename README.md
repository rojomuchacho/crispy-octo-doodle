# Headset: NFL Game Management Trainer

A browser game that teaches fans to think like a head coach: clock management, 4th-down decisions, two-point choices, and situational football.

## Play
Open `index.html` in a browser. No build step or dependencies.

## Modes
- **Play**: 10 random situations (or practice one category). Each shows a live scoreboard and field, you make the call, then get graded (Best / OK / Miss) with explanations and a coaching point.
- **Clock Lab**: enter clock, down, and opponent timeouts to see whether you can kneel out the game, snap by snap.
- **Cheat Sheet**: clock rules, kneel math, late-game two-point guide, 4th-down rules of thumb.

## Adding scenarios
Add entries to `SCENARIOS` in `js/scenarios.js`. `yardLine` is measured from the offense's own goal line (0–100); `possession` is `"us"` or `"them"`.
