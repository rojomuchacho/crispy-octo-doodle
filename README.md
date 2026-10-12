# Headset: NFL Game Management Trainer

A browser game that teaches fans to think like a head coach: clock management, 4th-down decisions, two-point choices, and situational football. Switch between **NFL** and **College** rules on the home screen.

## Play
Open `index.html` in a browser. No build step or dependencies.

## Modes
- **Real Moments (2026 season)**: real calls from this season's NFL and college games. Make your decision, then see what the coach actually did, how it played out, and sources.
- **Play**: 10 random situations (or practice one category). Each shows a live scoreboard and field, you make the call, then get graded (Best / OK / Miss) with explanations and a coaching point.
- **Clock Lab**: enter clock, down, and opponent timeouts to see whether you can kneel out the game, snap by snap.
- **Cheat Sheet**: NFL or college clock and overtime rules, kneel math, late-game two-point guide, 4th-down rules of thumb.

## Adding scenarios
Add entries to `SCENARIOS` in `js/scenarios.js`. `yardLine` is measured from the offense's own goal line (0–100); `possession` is `"us"` or `"them"`. Set `leagues: ["nfl"]` or `["cfb"]` for rules-specific scenarios (omit for both).

Real moments live in `js/real-moments.js`. Mark the option the real coach chose with `real: true`, cite `sources`, and leave unreported details (clock, timeouts, down) as `null` rather than guessing.
