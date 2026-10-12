// Drive Simulator: call every snap of a late-game drive. The decision clock runs in real
// time (40/25-second play clock, headset cutoff at :15, game clock ticking if it's running);
// each play is then resolved with simple, plausible odds and the real clock rules.
// Outcome odds are game approximations, not a statistical model.

const DRIVES = [
  {
    id: "two-minute", title: "Two-Minute Drill",
    blurb: "Down 3 with 2:00 left after the kickoff. Ball at your 25, two timeouts. A field goal ties, a touchdown wins.",
    start: { quarter: 4, clock: 120, score: { us: 17, them: 20 }, yardLine: 25, timeouts: { us: 2, them: 2 }, clockRunning: false },
  },
  {
    id: "four-minute", title: "Four-Minute Offense",
    blurb: "Up 4 with 4:10 left and the clock running. They have all three timeouts. Bleed the clock and don't give it back.",
    start: { quarter: 4, clock: 250, score: { us: 24, them: 20 }, yardLine: 30, timeouts: { us: 3, them: 3 }, clockRunning: true },
  },
  {
    id: "end-of-half", title: "End of the Half",
    blurb: "Tied with 0:58 before halftime, ball at your 25, two timeouts. Steal points without giving any back.",
    start: { quarter: 2, clock: 58, score: { us: 10, them: 10 }, yardLine: 25, timeouts: { us: 2, them: 3 }, clockRunning: false },
  },
  {
    id: "down-eight", title: "Down Eight",
    blurb: "Down 8 with 3:40 left, three timeouts. You need a touchdown and a two-point conversion, and maybe the ball back.",
    start: { quarter: 4, clock: 220, score: { us: 13, them: 21 }, yardLine: 22, timeouts: { us: 3, them: 3 }, clockRunning: false },
  },
];

const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.round(rnd(a, b));
const chance = (p) => Math.random() < p;

// Each play returns what happened; the engine applies clock and down rules.
// secs = time the play itself takes; oob = ended out of bounds; inc = incomplete.
const PLAYS = {
  runIn: { label: "Run inside", hint: "Safe, keeps the clock running",
    run: () => {
      if (chance(0.01)) return { fumble: true, yards: irnd(0, 3), secs: 5, text: "Run up the middle — FUMBLE! Defense recovers." };
      const y = chance(0.05) ? irnd(12, 30) : Math.max(-3, Math.round(rnd(-1, 7) + rnd(-1, 2)));
      return { yards: y, secs: irnd(4, 6), text: `Run up the middle for ${y} yard${Math.abs(y) === 1 ? "" : "s"}.` };
    } },
  runOut: { label: "Run outside", hint: "Can get out of bounds",
    run: () => {
      if (chance(0.012)) return { fumble: true, yards: irnd(0, 4), secs: 5, text: "Toss to the edge — FUMBLE! Defense recovers." };
      const y = chance(0.07) ? irnd(15, 40) : Math.round(rnd(-3, 9));
      const oob = chance(0.4);
      return { yards: y, oob, secs: irnd(5, 7), text: `Run outside for ${y} yard${Math.abs(y) === 1 ? "" : "s"}${oob ? ", out of bounds" : ""}.` };
    } },
  quickOut: { label: "Quick out", hint: "Sideline throw, often stops the clock",
    run: () => {
      if (chance(0.04)) return sack();
      if (chance(0.015)) return { int: true, yards: irnd(3, 8), secs: 5, text: "Quick out — INTERCEPTED by the corner!" };
      if (!chance(0.68)) return { inc: true, yards: 0, secs: 4, text: "Quick out, incomplete." };
      const y = irnd(3, 11), oob = chance(0.65);
      return { yards: y, oob, secs: 5, text: `Quick out complete for ${y}${oob ? ", out of bounds" : ", tackled in bounds"}.` };
    } },
  slant: { label: "Slant / middle", hint: "Higher percentage, stays in bounds",
    run: () => {
      if (chance(0.05)) return sack();
      if (chance(0.02)) return { int: true, yards: irnd(5, 10), secs: 5, text: "Slant — tipped and INTERCEPTED!" };
      if (!chance(0.7)) return { inc: true, yards: 0, secs: 4, text: "Slant, incomplete." };
      const y = chance(0.1) ? irnd(18, 35) : irnd(5, 13);
      return { yards: y, secs: irnd(5, 7), text: `Slant complete for ${y}, tackled in bounds.` };
    } },
  deep: { label: "Deep shot", hint: "Big gain or nothing",
    run: () => {
      if (chance(0.07)) return sack();
      if (chance(0.05)) return { int: true, yards: irnd(25, 40), secs: 7, text: "Deep shot — INTERCEPTED downfield!" };
      if (!chance(0.36)) return { inc: true, yards: 0, secs: 6, text: "Deep shot, overthrown. Incomplete." };
      const y = irnd(22, 45), oob = chance(0.25);
      return { yards: y, oob, secs: 7, text: `Deep shot COMPLETE for ${y}${oob ? ", out of bounds" : ""}!` };
    } },
  hail: { label: "Hail Mary", hint: "Last-second heave", when: (s) => s.yardLine >= 45,
    run: (s) => {
      const toGo = 100 - s.yardLine;
      if (chance(0.06)) return { int: true, yards: toGo - 5, secs: 8, text: "Hail Mary — picked off in the end zone." };
      if (chance(toGo <= 45 ? 0.1 : 0.05)) return { yards: toGo, secs: 8, text: "HAIL MARY... CAUGHT! TOUCHDOWN!" };
      return { inc: true, yards: 0, secs: 8, text: "Hail Mary batted down. Incomplete." };
    } },
  spike: { label: "Spike", hint: "Stops the clock, costs a down", when: (s) => s.clockRunning && s.down < 4,
    run: () => ({ inc: true, spike: true, yards: 0, secs: 1, text: "Spiked to stop the clock." }) },
  kneel: { label: "Kneel", hint: "Lose a yard, keep the clock running",
    run: () => ({ yards: -1, secs: 2, kneel: true, text: "Victory formation. Kneel." }) },
  fg: { label: "Field goal", hint: "", when: (s) => 100 - s.yardLine + 17 <= 66,
    run: (s) => {
      const dist = 100 - s.yardLine + 17;
      const make = dist <= 30 ? 0.98 : dist <= 40 ? 0.92 : dist <= 50 ? 0.78 : dist <= 55 ? 0.62 : dist <= 60 ? 0.42 : 0.15;
      const good = chance(make);
      return { fg: true, good, dist, secs: 4, text: `${dist}-yard field goal is ${good ? "GOOD!" : "NO GOOD."}` };
    } },
  punt: { label: "Punt", hint: "", when: (s) => s.yardLine < 65,
    run: (s) => ({ punt: true, net: irnd(36, 48), secs: 8, text: "Punt away." }) },
};
function sack() {
  const y = -irnd(4, 9);
  return chance(0.08)
    ? { fumble: true, yards: y, secs: 4, text: `SACKED and the ball comes loose! Defense recovers.` }
    : { yards: y, secs: 4, sack: true, text: `SACKED for a loss of ${-y}.` };
}

const TEMPO = {
  fast: { label: "Snap fast", desc: "No-huddle: snap with ~32 on the play clock" },
  normal: { label: "Normal", desc: "Huddle: snap with ~12 on the play clock" },
  milk: { label: "Milk it", desc: "Let the play clock run to :02" },
};

const sim = {
  drive: null, s: null, tempo: "normal", timer: null, pc: 40, huddle: 0, usedTO: false,
  busy: false, log: [], notes: [], stats: null, over: false, awaitingTry: false,
};

const fmt = (secs) => `${Math.floor(Math.max(0, secs) / 60)}:${String(Math.max(0, Math.round(secs)) % 60).padStart(2, "0")}`;
const isLate = (s) => s.quarter === 4 || s.quarter === 2;
const leading = (s) => s.score.us > s.score.them;
const trailing = (s) => s.score.us < s.score.them;

// ---------- Screens ----------
function renderSimMenu() {
  const list = $("sim-list");
  list.innerHTML = DRIVES.map((d) => `
    <button class="drive-card" data-drive="${d.id}">
      <span class="drive-title">${d.title}</span>
      <span class="drive-blurb">${d.blurb}</span>
    </button>`).join("");
  list.querySelectorAll("[data-drive]").forEach((b) => (b.onclick = () => startDrive(b.dataset.drive)));
}

function startDrive(id) {
  const d = DRIVES.find((x) => x.id === id);
  stopSimClock();
  SFX.start();
  startMusic();
  sim.drive = d;
  sim.s = { ...JSON.parse(JSON.stringify(d.start)), down: 1, distance: 10, league: state.league, warningUsed: d.start.clock <= 120 };
  Object.assign(sim, { log: [], notes: [], over: false, busy: false, awaitingTry: false, tempo: "normal",
    stats: { plays: 0, yards: 0, start: d.start.clock, timeoutsUsed: 0 } });
  $("sim-title").textContent = `${d.title} · ${LEAGUE_NAME[state.league]} rules`;
  $("sim-end").classList.add("hidden");
  $("sim-panel").classList.remove("hidden");
  addLog(`${d.blurb}`, "info");
  show("sim");
  renderTempo();
  newSnap(sim.s.clock <= 120 && !d.start.clockRunning && d.start.clock === 120 ? 25 : 40);
}

// ---------- Rendering ----------
function simSit() {
  const s = sim.s;
  return {
    quarter: s.quarter, clock: fmt(s.clock), clockRunning: s.clockRunning, score: s.score,
    possession: "us", down: s.down, distance: s.distance, yardLine: Math.round(s.yardLine),
    goalToGo: s.yardLine + s.distance >= 100, timeouts: s.timeouts, pat: sim.awaitingTry,
  };
}
function renderSim() {
  const sit = simSit();
  renderScoreboard(sit, $("sim-scoreboard"));
  renderField(sit, $("sim-field"));
  renderPlaycalls();
  renderSimClock();
}

function renderPlaycalls() {
  const s = sim.s;
  const box = $("sim-calls");
  if (sim.awaitingTry) {
    box.innerHTML = `
      <button class="call" data-try="pat"><span>Kick the PAT</span><small>~${s.league === "cfb" ? 98 : 94}%, 1 point</small></button>
      <button class="call" data-try="two"><span>Go for two</span><small>~48%, 2 points</small></button>`;
    box.querySelectorAll("[data-try]").forEach((b) => (b.onclick = () => runTry(b.dataset.try)));
    return;
  }
  box.innerHTML = Object.entries(PLAYS)
    .filter(([, p]) => !p.when || p.when(s))
    .map(([k, p]) => {
      const hint = k === "fg" ? `${100 - Math.round(s.yardLine) + 17} yards` : k === "punt" ? "Flip the field" : p.hint;
      return `<button class="call" data-play="${k}"><span>${p.label}</span><small>${hint}</small></button>`;
    }).join("");
  box.querySelectorAll("[data-play]").forEach((b) => {
    b.onclick = () => callPlay(b.dataset.play);
    b.onmouseenter = () => SFX.hover();
  });
  lockSimCalls();
}

function renderTempo() {
  document.querySelectorAll("[data-tempo]").forEach((b) => b.classList.toggle("active", b.dataset.tempo === sim.tempo));
  $("tempo-desc").textContent = TEMPO[sim.tempo].desc;
}

function renderSimClock() {
  const pc = $("sim-pc"), label = $("sim-pc-label"), led = $("sim-led");
  if (sim.huddle > 0) {
    label.textContent = "Timeout";
    pc.textContent = String(sim.huddle).padStart(2, "0");
    pc.classList.remove("danger");
    led.className = "led on";
    led.textContent = "Headset on";
  } else {
    label.textContent = "Play clock";
    pc.textContent = String(Math.max(0, sim.pc)).padStart(2, "0");
    pc.classList.toggle("danger", sim.pc <= 10);
    const on = !state.clockOn || sim.pc > HEADSET_CUTOFF;
    led.className = `led ${on ? "on" : "off"}`;
    led.textContent = on ? `Headset on · cuts out at :${HEADSET_CUTOFF}` : "Headset off";
  }
  const to = $("sim-timeout");
  to.disabled = sim.busy || sim.over || sim.usedTO || sim.awaitingTry || sim.s.timeouts.us <= 0;
  to.textContent = `Call timeout (${sim.s.timeouts.us} left)`;
  $("sim-break").classList.toggle("hidden", sim.huddle === 0);
  lockSimCalls();
}

const simLocked = () => state.clockOn && !sim.busy && sim.huddle === 0 && sim.pc <= HEADSET_CUTOFF && !sim.awaitingTry;
function lockSimCalls() {
  const locked = simLocked();
  document.querySelectorAll("#sim-calls .call").forEach((b) => (b.disabled = sim.busy || sim.over || locked));
  $("sim-audible").classList.toggle("hidden", !locked || sim.over);
}

function addLog(text, kind = "") {
  sim.log.unshift({ text, kind, clock: fmt(sim.s.clock), q: sim.s.quarter });
  $("sim-log").innerHTML = sim.log.slice(0, 40).map((l) =>
    `<li class="${l.kind}"><span class="log-clock">Q${l.q} ${l.clock}</span>${l.text}</li>`).join("");
}
function note(text, good = false) {
  if (!sim.notes.some((n) => n.text === text)) sim.notes.push({ text, good });
}

// ---------- Real-time decision clock ----------
function newSnap(playClock = 40) {
  sim.pc = playClock;
  sim.huddle = 0;
  sim.usedTO = false;
  sim.busy = false;
  renderSim();
  SFX.snap();
  stopSimClock();
  sim.timer = setInterval(simTick, 1000);
}
function stopSimClock() {
  clearInterval(sim.timer);
  sim.timer = null;
}

function simTick() {
  if (sim.busy || sim.over) return;
  if (sim.huddle > 0) {
    sim.huddle--;
    if (sim.huddle === 0) { sim.pc = 25; SFX.snap(); }
    renderSimClock();
    return;
  }
  if (!state.clockOn) return;
  sim.pc--;
  if (sim.pc === HEADSET_CUTOFF) SFX.static();
  if (sim.pc <= 5 && sim.pc > 0) SFX.tick();
  if (sim.s.clockRunning && !sim.awaitingTry) {
    if (runGameClock(1)) { renderSim(); return; }
    renderScoreboard(simSit(), $("sim-scoreboard"));
  }
  renderSimClock();
  if (sim.pc <= 0) delayOfGame();
}

// Runs the game clock; returns true if the period ended.
function runGameClock(secs) {
  const s = sim.s;
  const before = s.clock;
  s.clock = Math.max(0, s.clock - secs);
  if (isLate(s) && !s.warningUsed && before > 120 && s.clock <= 120) {
    s.clock = 120;
    s.clockRunning = false;
    s.warningUsed = true;
    addLog("Two-minute warning.", "info");
    flashSimNote("Two-minute warning");
    SFX.whistle();
    sim.pc = 25;
    return false;
  }
  if (s.clock <= 0) {
    endPeriod();
    return true;
  }
  return false;
}

function flashSimNote(text) {
  const n = $("sim-note");
  n.textContent = text;
  n.classList.remove("hidden");
  clearTimeout(flashSimNote.t);
  flashSimNote.t = setTimeout(() => n.classList.add("hidden"), 2200);
}

function simTimeout() {
  if ($("sim-timeout").disabled) return;
  const s = sim.s;
  s.timeouts.us--;
  sim.stats.timeoutsUsed++;
  if (!s.clockRunning && !leading(s)) note(`Used a timeout with the clock already stopped (Q${s.quarter} ${fmt(s.clock)}).`);
  if (leading(s) && s.clockRunning && s.quarter === 4) note("Called a timeout while protecting a lead — that stops a clock you want running.");
  s.clockRunning = false;
  sim.usedTO = true;
  sim.huddle = HUDDLE_SECS;
  addLog(`Timeout, your ball. ${s.timeouts.us} left.`, "info");
  SFX.whistle();
  renderSim();
}
function breakHuddle() {
  if (sim.huddle > 0) { sim.huddle = 0; sim.pc = 25; renderSimClock(); }
}

function delayOfGame() {
  const s = sim.s;
  s.yardLine = Math.max(1, s.yardLine - 5);
  s.distance += 5;
  addLog("DELAY OF GAME. 5-yard penalty, replay the down.", "bad");
  note("Took a delay-of-game penalty — no call got in before the play clock expired.");
  SFX.bad();
  // Inside the final minute, an offensive foul that stops the clock carries a 10-second runoff.
  if (s.clockRunning && isLate(s) && s.clock <= 60) {
    addLog("10-second runoff.", "bad");
    if (runGameClock(10)) return;
  }
  newSnap(25);
}

function simAudible() {
  if (!simLocked()) return;
  const k = sim.s.clockRunning && trailing(sim.s) ? "quickOut" : chance(0.5) ? "runIn" : "slant";
  addLog(`No call got in. QB audibles to: ${PLAYS[k].label}.`, "info");
  note("Let the headset cut out and had to rely on a QB audible.");
  callPlay(k, true);
}

// ---------- Play resolution ----------
function callPlay(key, audible = false) {
  if (sim.busy || sim.over) return;
  if (!audible && simLocked()) return;
  const s = sim.s;
  sim.busy = true;
  stopSimClock();
  lockSimCalls();
  SFX.click();
  critiqueCall(key);

  // Time between the call and the snap.
  if (s.clockRunning) {
    const set = sim.tempo === "fast" ? Math.max(0, sim.pc - 32) : sim.tempo === "normal" ? Math.max(0, sim.pc - 12) : Math.max(0, sim.pc - 2);
    if (set > 0) {
      const warningBefore = s.warningUsed;
      if (runGameClock(set)) { renderSim(); return; }
      if (!warningBefore && s.warningUsed) {
        // The two-minute warning hit before the snap: regroup and call it again.
        sim.busy = false;
        newSnap(25);
        return;
      }
    }
  }

  const play = PLAYS[key];
  const r = play.run(s);
  sim.stats.plays++;
  // The clock always runs during the play once the ball is snapped.
  const startClock = s.clock;
  s.clock = Math.max(0, s.clock - r.secs);
  let warningHit = false;
  if (isLate(s) && !s.warningUsed && startClock > 120 && s.clock <= 120) {
    s.clock = 120; s.warningUsed = true; warningHit = true;
  }
  const periodOver = s.clock <= 0;
  addLog(r.text, r.int || r.fumble ? "bad" : r.yards >= 10 || r.good ? "good" : "");
  resolve(r, key, warningHit, periodOver);
}

function resolve(r, key, warningHit, periodOver) {
  const s = sim.s;
  const animateTo = (yl, then) => {
    const ball = $("sim-field").querySelector(".football");
    if (ball && !reduceMotion) {
      ball.style.left = `${Math.min(97, Math.max(2, fieldPct(Math.min(105, Math.max(-5, yl)))))}%`;
      setTimeout(then, 900);
    } else then();
  };

  // Turnovers.
  if (r.int || r.fumble) {
    SFX.bad();
    showSimBanner(r.int ? "INTERCEPTED" : "FUMBLE", "bad");
    const spot = Math.min(99, Math.max(1, s.yardLine + (r.yards || 0)));
    animateTo(spot, () => opponentDrive(100 - spot, periodOver, "turnover"));
    return;
  }
  if (r.fg) {
    if (r.good) {
      s.score.us += 3;
      SFX.fanfare();
      showSimBanner("IT'S GOOD!", "best");
      afterScore(periodOver);
    } else {
      SFX.bad();
      showSimBanner("NO GOOD", "bad");
      opponentDrive(Math.max(20, 100 - (s.yardLine - 7)), periodOver, "missed FG");
    }
    return;
  }
  if (r.punt) {
    const land = s.yardLine + r.net;
    const oppStart = land >= 100 ? 20 : 100 - land;
    SFX.click();
    opponentDrive(oppStart, periodOver, "punt");
    return;
  }

  const newYL = s.yardLine + r.yards;
  sim.stats.yards += r.yards;
  animateTo(newYL, () => {
    if (newYL >= 100) {
      s.score.us += 6;
      SFX.fanfare();
      showSimBanner("TOUCHDOWN!", "best");
      s.clockRunning = false;
      sim.awaitingTry = true;
      sim.busy = false;
      s.yardLine = 98;
      renderSim();
      stopSimClock();
      return;
    }
    if (newYL <= 0) {
      s.score.them += 2;
      SFX.bad();
      showSimBanner("SAFETY", "bad");
      opponentDrive(35, periodOver, "safety");
      return;
    }
    // Downs and distance.
    s.yardLine = newYL;
    let firstDown = false;
    if (r.yards >= s.distance) {
      s.down = 1; firstDown = true;
      s.distance = Math.min(10, 100 - s.yardLine);
    } else {
      s.down++; s.distance -= r.yards;
    }
    if (s.down > 4) {
      SFX.bad();
      showSimBanner("TURNOVER ON DOWNS", "bad");
      addLog("Turnover on downs.", "bad");
      opponentDrive(100 - s.yardLine, periodOver, "downs");
      return;
    }
    if (r.yards >= 10) SFX.best(); else if (r.inc || r.sack) SFX.ok(); else SFX.click();

    // Clock status after the play.
    const finalMinutes = (s.quarter === 4 && s.clock <= 300) || (s.quarter === 2 && s.clock <= 120);
    if (r.inc) s.clockRunning = false;
    else if (r.oob) s.clockRunning = !finalMinutes; // outside the late windows it restarts right away
    else s.clockRunning = true;
    if (warningHit) { s.clockRunning = false; addLog("Two-minute warning.", "info"); }
    // College: a first down in the last 2:00 of a half stops the clock while the chains move.
    let chainsCredit = 0;
    if (s.league === "cfb" && firstDown && s.clockRunning && s.clock <= 120 && isLate(s)) {
      chainsCredit = 1;
      addLog("First down — clock stops for the chains (college rule).", "info");
    }
    if (periodOver) { endPeriod(); return; }

    // The defense uses its timeouts when it's trailing late and the clock is running.
    if (s.clockRunning && isLate(s) && s.clock <= 300 && leading(s) && s.timeouts.them > 0) {
      s.timeouts.them--;
      s.clockRunning = false;
      addLog(`Opponent timeout. They have ${s.timeouts.them} left.`, "info");
    }
    sim.busy = false;
    let pcNext = warningHit ? 25 : 40;
    if (chainsCredit) { s.clockRunning = false; sim.cfbRestart = true; }
    newSnap(pcNext);
    // After the chains are set in college, the clock starts again on the ready signal.
    if (sim.cfbRestart) { sim.cfbRestart = false; setTimeout(() => { if (!sim.over && !sim.busy) { s.clockRunning = true; renderSim(); } }, 2500); }
  });
}

function runTry(kind) {
  const s = sim.s;
  const good = kind === "pat" ? chance(s.league === "cfb" ? 0.98 : 0.94) : chance(0.48);
  if (good) s.score.us += kind === "pat" ? 1 : 2;
  addLog(`${kind === "pat" ? "Extra point" : "Two-point try"} ${good ? "is GOOD" : "FAILS"}.`, good ? "good" : "bad");
  (good ? SFX.best : SFX.bad)();
  showSimBanner(good ? (kind === "pat" ? "PAT GOOD" : "2-POINT GOOD!") : "NO GOOD", good ? "best" : "bad");
  // Margin coaching: compare against the standard chart.
  const diffBefore = s.score.us - (good ? (kind === "pat" ? 1 : 2) : 0) - s.score.them;
  const goFor2 = [-2, -5, -8, 1, 5].includes(diffBefore);
  if (goFor2 && kind === "pat") note(`Kicked the PAT ${diffBefore < 0 ? "down" : "up"} ${Math.abs(diffBefore)} after the TD — the chart says go for two there.`);
  if (goFor2 && kind === "two") note(`Went for two ${diffBefore < 0 ? "down" : "up"} ${Math.abs(diffBefore)} — that's the right side of the chart.`, true);
  sim.awaitingTry = false;
  afterScore(s.clock <= 0);
}

function afterScore(periodOver) {
  const s = sim.s;
  if (periodOver || s.clock <= 0) { endPeriod(); return; }
  opponentDrive(25, false, "kickoff");
}

// ---------- Opponent possession (summarized) ----------
function opponentDrive(start, periodOver, why) {
  const s = sim.s;
  sim.busy = true;
  stopSimClock();
  if (periodOver || s.clock <= 0) { endPeriod(); return; }
  const T = s.clock;
  const theyLead = s.score.them > s.score.us;
  const tied = s.score.them === s.score.us;
  let used, result;
  // Our timeouts: we burn them on defense if we're trailing or tied late.
  let ourTOs = 0;
  if (!leading(s) && isLate(s) && T <= 300) { ourTOs = s.timeouts.us; s.timeouts.us = 0; }

  const fieldBonus = start / 100;
  if (theyLead) {
    used = Math.min(T, irnd(110, 220) - ourTOs * 38);
    const pTD = 0.12 + 0.3 * fieldBonus, pFG = 0.2;
    result = chance(pTD) ? "TD" : chance(pFG) ? "FG" : "punt";
  } else {
    // They need points: hurry-up.
    const urgency = T < 300;
    used = Math.min(T, urgency ? irnd(45, 140) : irnd(120, 260));
    const timeFactor = Math.min(1, T / 75);
    const pTD = (0.14 + 0.32 * fieldBonus) * timeFactor;
    const pFG = (tied || s.score.us - s.score.them <= 3 ? 0.35 : 0.15) * Math.min(1, T / 40 + 0.3);
    result = chance(pTD) ? "TD" : chance(pFG) ? "FG" : "punt";
    if (used >= T && result === "punt") result = "none";
  }
  used = Math.max(5, used);
  s.clock = Math.max(0, T - used);
  if (ourTOs) addLog(`You burned ${ourTOs} timeout${ourTOs > 1 ? "s" : ""} on defense.`, "info");
  const verb = { TD: "TOUCHDOWN", FG: "FIELD GOAL", punt: "punt", none: "ran out the clock" }[result];
  if (result === "TD") s.score.them += 7;
  if (result === "FG") s.score.them += 3;
  addLog(`Opponent ball (${why}) at their ${Math.round(start)}: ${irnd(3, 10)} plays, ${fmt(used)} — ${verb}.`, result === "TD" || result === "FG" ? "bad" : "info");
  if (result === "TD" || result === "FG") SFX.bad();

  if (s.clock <= 0) { endPeriod(); return; }
  // We get it back.
  s.yardLine = result === "punt" ? irnd(12, 30) : 25;
  s.down = 1; s.distance = 10;
  s.clockRunning = false;
  if (!s.warningUsed && isLate(s) && T > 120 && s.clock <= 120) s.warningUsed = true;
  addLog(`Your ball at your own ${s.yardLine}.`, "info");
  sim.busy = false;
  setTimeout(() => newSnap(40), 600);
}

// ---------- Coaching critiques ----------
function critiqueCall(key) {
  const s = sim.s;
  const late4 = s.quarter === 4 && s.clock <= 300;
  if (late4 && trailing(s) && s.clockRunning && sim.tempo === "milk") note(`Milked the clock while trailing (Q4 ${fmt(s.clock)}).`);
  if (late4 && leading(s) && s.clockRunning && sim.tempo === "fast") note(`Hurried to the line while protecting a lead (Q4 ${fmt(s.clock)}).`);
  if (late4 && leading(s) && ["quickOut", "deep", "hail"].includes(key)) note(`Threw a clock-stopping pass with the lead (Q4 ${fmt(s.clock)}).`);
  if (late4 && leading(s) && key === "kneel") note("Took a knee to drain clock with the lead.", true);
  if (trailing(s) && key === "kneel") note("Knelt while trailing.");
  if (key === "spike" && s.timeouts.us > 0 && s.clock > 30) note(`Spiked with ${s.timeouts.us} timeout${s.timeouts.us > 1 ? "s" : ""} left and ${fmt(s.clock)} to play — a timeout would have saved the down.`);
  if (key === "fg" && s.quarter === 4 && s.score.them - s.score.us > 3) note(`Kicked a field goal down ${s.score.them - s.score.us} late — it doesn't tie or win.`);
  if (key === "punt" && s.quarter === 4 && trailing(s) && s.clock < 150) note(`Punted while trailing with ${fmt(s.clock)} left.`);
  if (key === "quickOut" && trailing(s) && late4) note("Used the sideline to manage the clock while trailing.", true);
}

// ---------- End of period ----------
function endPeriod() {
  const s = sim.s;
  if (sim.over) return;
  sim.over = true;
  sim.busy = true;
  stopSimClock();
  s.clock = 0;
  renderSim();
  const d = s.score.us - s.score.them;
  const start = sim.drive.start.score;
  let head, grade;
  if (s.quarter === 2) {
    const net = (s.score.us - start.us) - (s.score.them - start.them);
    head = net > 0 ? `Halftime: +${net} for you` : net < 0 ? `Halftime: you gave up ${-net}` : "Halftime: no damage either way";
    grade = net >= 3 ? "best" : net >= 0 ? "ok" : "bad";
  } else {
    head = d > 0 ? "FINAL — YOU WIN" : d < 0 ? "FINAL — YOU LOSE" : "END OF REGULATION — HEADED TO OVERTIME";
    grade = d > 0 ? "best" : d === 0 ? "ok" : "bad";
  }
  if (s.quarter === 4 && trailing(s) && s.timeouts.us > 0) note(`Finished trailing with ${s.timeouts.us} timeout${s.timeouts.us > 1 ? "s" : ""} unused.`);
  (grade === "best" ? SFX.fanfare : grade === "ok" ? SFX.ok : SFX.gameOver)();
  stopMusic();
  addLog(head, grade === "bad" ? "bad" : "good");
  showSimBanner(grade === "best" ? "VICTORY" : grade === "ok" ? (s.quarter === 2 ? "HALFTIME" : "OVERTIME") : "DEFEAT", grade);

  const good = sim.notes.filter((n) => n.good), bad = sim.notes.filter((n) => !n.good);
  $("sim-end").innerHTML = `
    <h2 class="sim-end-head ${grade}">${head}</h2>
    <p class="sim-score">Final score: You ${s.score.us}, Opponent ${s.score.them}</p>
    <div class="stats">
      <div class="stat"><span class="stat-label">Your plays</span><span class="stat-value">${sim.stats.plays}</span></div>
      <div class="stat"><span class="stat-label">Yards</span><span class="stat-value">${sim.stats.yards}</span></div>
      <div class="stat"><span class="stat-label">Timeouts used</span><span class="stat-value">${sim.stats.timeoutsUsed}</span></div>
    </div>
    <h3>Film room</h3>
    <ul class="film">${[...bad.map((n) => `<li class="bad">✗ ${n.text}</li>`), ...good.map((n) => `<li class="good">✓ ${n.text}</li>`)].join("") || "<li>Clean game management. No red flags.</li>"}</ul>
    <p class="fine">Play outcomes are randomized with game-style odds, so the same calls can play out differently. Judge the calls in the film room, not just the scoreboard.</p>
    <div class="btn-row">
      <button class="primary" id="sim-again">▶ Run it back</button>
      <button class="primary alt" id="sim-menu">Other drives</button>
    </div>`;
  $("sim-end").classList.remove("hidden");
  $("sim-panel").classList.add("hidden");
  $("sim-again").onclick = () => startDrive(sim.drive.id);
  $("sim-menu").onclick = () => { renderSimMenu(); show("home"); document.getElementById("sim-menu-card").scrollIntoView(); };
}

function showSimBanner(text, grade) {
  showBanner(text, grade, 0);
}

// ---------- Wiring ----------
document.querySelectorAll("[data-tempo]").forEach((b) => (b.onclick = () => { sim.tempo = b.dataset.tempo; SFX.click(); renderTempo(); }));
$("sim-timeout").onclick = simTimeout;
$("sim-break").onclick = breakHuddle;
$("sim-audible").onclick = simAudible;
document.addEventListener("keydown", (e) => {
  if ($("sim").classList.contains("hidden") || e.target.matches("input, select, textarea")) return;
  if (e.key === "t" || e.key === "T") simTimeout();
  else if (e.key === "a" || e.key === "A") simAudible();
  else if (/^[1-9]$/.test(e.key)) {
    const b = document.querySelectorAll("#sim-calls .call")[Number(e.key) - 1];
    if (b && !b.disabled) b.click();
  }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) stopSimClock(); else if (!$("sim").classList.contains("hidden") && !sim.over && !sim.busy && !sim.timer) sim.timer = setInterval(simTick, 1000); });
// Leaving the simulator stops its clock.
document.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", stopSimClock));
renderSimMenu();
