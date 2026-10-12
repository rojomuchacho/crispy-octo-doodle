// Kneel-down simulator. Assumes the offense lets the 40-second play clock
// run all the way down while the game clock is running, each kneel takes
// KNEEL_SECONDS, and the defense calls a timeout after every kneel while it has one.
const PLAY_CLOCK = 40;
const KNEEL_SECONDS = 2;
const WARNING = 120;

function fmtClock(secs) {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function simulateKneels({ seconds, down, oppTimeouts, clockRunning, warningPending }) {
  let t = seconds;
  let running = clockRunning;
  let timeouts = oppTimeouts;
  let warning = warningPending && t > WARNING;
  const log = [];
  const ord = ["", "1st", "2nd", "3rd", "4th"];

  for (let d = down; d <= 4; d++) {
    if (running) {
      if (warning && t - PLAY_CLOCK <= WARNING) {
        t = WARNING;
        running = false;
        warning = false;
        log.push(`Clock runs to the two-minute warning (${fmtClock(t)}).`);
      } else {
        t -= PLAY_CLOCK;
        if (t <= 0) {
          log.push("Play clock runs down — game clock hits 0:00.");
          return { win: true, remaining: 0, log };
        }
        log.push(`Let the play clock run → ${fmtClock(t)}.`);
      }
    }
    const before = t;
    t -= KNEEL_SECONDS;
    running = true;
    if (warning && before > WARNING && t <= WARNING) {
      running = false;
      warning = false;
    }
    if (t <= 0) {
      log.push(`${ord[d]}-down kneel — time expires.`);
      return { win: true, remaining: 0, log };
    }
    let note = `${ord[d]}-down kneel → ${fmtClock(t)}`;
    if (!running) note += " (two-minute warning)";
    if (running && timeouts > 0 && d < 4) {
      timeouts--;
      running = false;
      note += `. Opponent calls timeout (${timeouts} left)`;
    }
    log.push(note + ".");
    if (d === 4) {
      log.push(`Turnover on downs: opponent gets the ball with ${fmtClock(t)} left.`);
      return { win: false, remaining: t, log };
    }
  }
  return { win: false, remaining: t, log };
}

if (typeof module !== "undefined") module.exports = { simulateKneels, fmtClock };
