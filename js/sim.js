// Drive Simulator: play out a late-game situation snap by snap, on offense and defense.
// The decision clock runs in real time (40/25-second play clock, headset cutoff at :15,
// game clock ticking while it's running). Each snap is animated, then resolved with
// simple game-style odds and the real clock rules. Possession flips until time expires.
// Outcome odds are approximations for the game, not a statistical model.

const DRIVES = [
  // Offense first
  { id: "two-minute", side: "offense", title: "Two-Minute Drill",
    blurb: "Down 3 with 2:00 left after the kickoff. Ball at your 25, two timeouts. A field goal ties, a touchdown wins.",
    start: { quarter: 4, clock: 120, score: { us: 17, them: 20 }, poss: "us", yardLine: 25, timeouts: { us: 2, them: 2 }, clockRunning: false } },
  { id: "four-minute", side: "offense", title: "Four-Minute Offense",
    blurb: "Up 4 with 4:10 left and the clock running. They have all three timeouts. Bleed the clock and don't give it back.",
    start: { quarter: 4, clock: 250, score: { us: 24, them: 20 }, poss: "us", yardLine: 30, timeouts: { us: 3, them: 3 }, clockRunning: true } },
  { id: "end-of-half", side: "offense", title: "End of the Half",
    blurb: "Tied with 0:58 before halftime, ball at your 25, two timeouts. Steal points without giving any back.",
    start: { quarter: 2, clock: 58, score: { us: 10, them: 10 }, poss: "us", yardLine: 25, timeouts: { us: 2, them: 3 }, clockRunning: false } },
  { id: "down-eight", side: "offense", title: "Down Eight",
    blurb: "Down 8 with 3:40 left, three timeouts. You need a touchdown and a two-point conversion, and maybe the ball back.",
    start: { quarter: 4, clock: 220, score: { us: 13, them: 21 }, poss: "us", yardLine: 22, timeouts: { us: 3, them: 3 }, clockRunning: false } },
  // Defense first
  { id: "get-it-back", side: "defense", title: "Get the Ball Back",
    blurb: "Down 4 with 3:10 left. They have the ball at their 35 and want to run out the clock. You have three timeouts.",
    start: { quarter: 4, clock: 190, score: { us: 20, them: 24 }, poss: "them", yardLine: 35, timeouts: { us: 3, them: 2 }, clockRunning: true } },
  { id: "prevent", side: "defense", title: "Protect the Lead",
    blurb: "Up 3 with 1:35 left. They get the ball at their 25 with one timeout and need a field goal to tie.",
    start: { quarter: 4, clock: 95, score: { us: 27, them: 24 }, poss: "them", yardLine: 25, timeouts: { us: 2, them: 1 }, clockRunning: false } },
  { id: "goal-line", side: "defense", title: "Goal-Line Stand",
    blurb: "Tied with 1:50 left. They have 1st & goal at your 6 and can bleed the clock for a chip-shot field goal. You have two timeouts.",
    start: { quarter: 4, clock: 110, score: { us: 21, them: 21 }, poss: "them", yardLine: 94, down: 1, distance: 6, timeouts: { us: 2, them: 2 }, clockRunning: true } },
  { id: "half-defense", side: "defense", title: "Hold Before Half",
    blurb: "Tied with 0:52 before halftime. They have the ball at their 40 with one timeout. Don't give up a cheap score.",
    start: { quarter: 2, clock: 52, score: { us: 14, them: 14 }, poss: "them", yardLine: 40, timeouts: { us: 3, them: 1 }, clockRunning: false } },
];

const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.round(rnd(a, b));
const chance = (p) => Math.random() < Math.max(0.01, Math.min(0.97, p));
const other = (team) => (team === "us" ? "them" : "us");

// ---------- Defensive calls change the odds ----------
const MOD_BASE = { runY: 1, comp: 0, passY: 1, sack: 0, int: 0, oob: 1, deepComp: 0, shortComp: 0, outComp: 0 };
const DEF_CALLS = {
  base: { label: "Base defense", hint: "Balanced against run and pass", mod: {} },
  box: { label: "Stack the box", hint: "Stuffs the run, weak against the pass", mod: { runY: 0.55, comp: 0.06, passY: 1.2 } },
  blitz: { label: "Blitz", hint: "More sacks, but big plays if they beat it", mod: { sack: 0.12, comp: -0.08, passY: 1.35, int: 0.01, runY: 1.1 } },
  cover2: { label: "Cover 2", hint: "Takes away the sideline and deep ball", mod: { outComp: -0.22, oob: 0.5, deepComp: -0.1, runY: 1.15 } },
  prevent: { label: "Prevent", hint: "No deep balls; allows short catches in bounds", mod: { deepComp: -0.25, shortComp: 0.12, passY: 1.15, oob: 0.4, runY: 1.25, sack: -0.03 } },
  letScore: { label: "Let them score", hint: "Get the ball back with time on the clock", when: (s) => s.yardLine >= 88 },
};
const modFor = (call) => ({ ...MOD_BASE, ...((DEF_CALLS[call] || DEF_CALLS.base).mod || {}) });

// ---------- Offensive plays ----------
// Each play returns what happened; the engine applies clock and down rules.
const PLAYS = {
  runIn: { label: "Run inside", hint: "Safe, keeps the clock running",
    run: (s, m) => {
      if (chance(0.01)) return { fumble: true, yards: irnd(0, 3), secs: 5, text: "Run up the middle — FUMBLE! Recovered by the defense." };
      const raw = chance(0.05) ? irnd(12, 30) : rnd(-1, 7) + rnd(-1, 2);
      const y = Math.max(-3, Math.round(raw * (raw > 0 ? m.runY : 1)));
      return { yards: y, secs: irnd(4, 6), text: `Run up the middle for ${y} yard${Math.abs(y) === 1 ? "" : "s"}.` };
    } },
  runOut: { label: "Run outside", hint: "Can get out of bounds",
    run: (s, m) => {
      if (chance(0.012)) return { fumble: true, yards: irnd(0, 4), secs: 5, text: "Toss to the edge — FUMBLE! Recovered by the defense." };
      const raw = chance(0.07) ? irnd(15, 40) : rnd(-3, 9);
      const y = Math.round(raw * (raw > 0 ? m.runY : 1));
      const oob = chance(0.4 * m.oob);
      return { yards: y, oob, secs: irnd(5, 7), text: `Run outside for ${y} yard${Math.abs(y) === 1 ? "" : "s"}${oob ? ", out of bounds" : ""}.` };
    } },
  quickOut: { label: "Quick out", hint: "Sideline throw, often stops the clock",
    run: (s, m) => {
      if (chance(0.04 + m.sack)) return sack();
      if (chance(0.015 + m.int)) return { int: true, yards: irnd(3, 8), secs: 5, text: "Quick out — INTERCEPTED by the corner!" };
      if (!chance(0.68 + m.comp + m.shortComp + m.outComp)) return { inc: true, yards: 0, secs: 4, text: "Quick out, incomplete." };
      const y = Math.round(irnd(3, 11) * m.passY), oob = chance(0.65 * m.oob);
      return { yards: y, oob, secs: 5, text: `Quick out complete for ${y}${oob ? ", out of bounds" : ", tackled in bounds"}.` };
    } },
  slant: { label: "Slant / middle", hint: "Higher percentage, stays in bounds",
    run: (s, m) => {
      if (chance(0.05 + m.sack)) return sack();
      if (chance(0.02 + m.int)) return { int: true, yards: irnd(5, 10), secs: 5, text: "Slant — tipped and INTERCEPTED!" };
      if (!chance(0.7 + m.comp + m.shortComp)) return { inc: true, yards: 0, secs: 4, text: "Slant, incomplete." };
      const y = Math.round((chance(0.1) ? irnd(18, 35) : irnd(5, 13)) * m.passY);
      return { yards: y, secs: irnd(5, 7), text: `Slant complete for ${y}, tackled in bounds.` };
    } },
  deep: { label: "Deep shot", hint: "Big gain or nothing",
    run: (s, m) => {
      if (chance(0.07 + m.sack)) return sack();
      if (chance(0.05 + m.int)) return { int: true, yards: irnd(25, 40), secs: 7, text: "Deep shot — INTERCEPTED downfield!" };
      if (!chance(0.36 + m.comp + m.deepComp)) return { inc: true, yards: 0, secs: 6, text: "Deep shot, overthrown. Incomplete." };
      const y = Math.min(100 - s.yardLine, irnd(22, 45)), oob = chance(0.25 * m.oob);
      return { yards: y, oob, secs: 7, text: `Deep shot COMPLETE for ${y}${oob ? ", out of bounds" : ""}!` };
    } },
  hail: { label: "Hail Mary", hint: "Last-second heave", when: (s) => s.yardLine >= 45,
    run: (s, m) => {
      const toGo = 100 - s.yardLine;
      if (chance(0.06 + m.int)) return { int: true, yards: toGo - 5, secs: 8, text: "Hail Mary — picked off in the end zone." };
      if (chance((toGo <= 45 ? 0.1 : 0.05) + m.deepComp * 0.2)) return { yards: toGo, secs: 8, text: "HAIL MARY... CAUGHT! TOUCHDOWN!" };
      return { inc: true, yards: 0, secs: 8, text: "Hail Mary batted down. Incomplete." };
    } },
  spike: { label: "Spike", hint: "Stops the clock, costs a down", when: (s) => s.clockRunning && s.down < 4,
    run: () => ({ inc: true, spike: true, yards: 0, secs: 1, text: "Spiked to stop the clock." }) },
  kneel: { label: "Kneel", hint: "Lose a yard, keep the clock running",
    run: () => ({ yards: -1, secs: 2, kneel: true, text: "Victory formation. Kneel." }) },
  fg: { label: "Field goal", hint: "", when: (s) => 100 - s.yardLine + 17 <= 66,
    run: (s) => {
      const dist = Math.round(100 - s.yardLine + 17);
      const make = dist <= 30 ? 0.98 : dist <= 40 ? 0.92 : dist <= 50 ? 0.78 : dist <= 55 ? 0.62 : dist <= 60 ? 0.42 : 0.15;
      const good = chance(make);
      return { fg: true, good, dist, secs: 4, text: `${dist}-yard field goal is ${good ? "GOOD!" : "NO GOOD."}` };
    } },
  punt: { label: "Punt", hint: "Flip the field", when: (s) => s.yardLine < 65,
    run: () => ({ punt: true, net: irnd(36, 48), secs: 8, text: "Punt away." }) },
};
function sack() {
  const y = -irnd(4, 9);
  return chance(0.08)
    ? { fumble: true, sack: true, yards: y, secs: 4, text: "SACKED and the ball comes loose! Defense recovers." }
    : { yards: y, secs: 4, sack: true, text: `SACKED for a loss of ${-y}.` };
}

const TEMPO = {
  fast: { label: "Snap fast", desc: "No-huddle: snap with ~32 on the play clock" },
  normal: { label: "Normal", desc: "Huddle: snap with ~12 on the play clock" },
  milk: { label: "Milk it", desc: "Let the play clock run to :02" },
};
const TEMPO_SNAP = { fast: 32, normal: 12, milk: 2 };

const sim = {
  drive: null, s: null, tempo: "normal", timer: null, pc: 40, huddle: 0, usedTO: false,
  busy: false, log: [], notes: [], stats: null, over: false, awaitingTry: false, aiSnapAt: 12, wasted: 0,
};

const fmt = (secs) => `${Math.floor(Math.max(0, Math.round(secs)) / 60)}:${String(Math.max(0, Math.round(secs)) % 60).padStart(2, "0")}`;
const isLate = (s) => s.quarter === 4 || s.quarter === 2;
const lead = (s, team) => s.score[team] - s.score[other(team)];
const onOffense = () => sim.s.poss === "us";

// ---------- Menu ----------
function renderSimMenu() {
  const card = (d) => `
    <button class="drive-card ${d.side}" data-drive="${d.id}">
      <span class="drive-side">${d.side === "offense" ? "Offense" : "Defense"}</span>
      <span class="drive-title">${d.title}</span>
      <span class="drive-blurb">${d.blurb}</span>
    </button>`;
  $("sim-list").innerHTML = DRIVES.map(card).join("");
  $("sim-list").querySelectorAll("[data-drive]").forEach((b) => (b.onclick = () => startDrive(b.dataset.drive)));
}

function startDrive(id) {
  const d = DRIVES.find((x) => x.id === id);
  stopSimClock();
  SFX.start();
  startMusic();
  sim.drive = d;
  const st = JSON.parse(JSON.stringify(d.start));
  sim.s = { down: 1, distance: 10, ...st, league: state.league, warningUsed: st.clock <= 120 };
  Object.assign(sim, { log: [], notes: [], over: false, busy: false, awaitingTry: false, tempo: "normal", wasted: 0,
    stats: { plays: 0, yards: 0, timeoutsUsed: 0, stops: 0 } });
  $("sim-title").textContent = `${d.title} · ${LEAGUE_NAME[state.league]} rules`;
  $("sim-end").classList.add("hidden");
  $("sim-panel").classList.remove("hidden");
  addLog(d.blurb, "info");
  show("sim");
  renderTempo();
  newSnap(st.clock === 120 && !st.clockRunning ? 25 : 40);
}

// ---------- Rendering ----------
function simSit() {
  const s = sim.s;
  return {
    quarter: s.quarter, clock: fmt(s.clock), clockRunning: s.clockRunning, score: s.score,
    possession: s.poss, down: s.down, distance: s.distance, yardLine: Math.round(s.yardLine),
    goalToGo: s.yardLine + s.distance >= 100, timeouts: s.timeouts, pat: sim.awaitingTry,
  };
}
function renderSim() {
  const sit = simSit();
  renderScoreboard(sit, $("sim-scoreboard"));
  renderField(sit, $("sim-field"));
  renderCalls();
  renderSimClock();
}

function renderCalls() {
  const s = sim.s;
  const box = $("sim-calls");
  $("sim-side").textContent = onOffense() ? "You're on offense" : "You're on defense";
  $("sim-side").className = `side-tag ${onOffense() ? "off" : "def"}`;
  $("tempo-wrap").classList.toggle("hidden", !onOffense() || sim.awaitingTry);
  if (sim.awaitingTry) {
    box.innerHTML = `
      <button class="call" data-try="pat"><span>Kick the PAT</span><small>~${s.league === "cfb" ? 98 : 94}%, 1 point</small></button>
      <button class="call" data-try="two"><span>Go for two</span><small>~48%, 2 points</small></button>`;
    box.querySelectorAll("[data-try]").forEach((b) => (b.onclick = () => runTry("us", b.dataset.try)));
    return;
  }
  if (onOffense()) {
    box.innerHTML = Object.entries(PLAYS).filter(([, p]) => !p.when || p.when(s)).map(([k, p]) => {
      const hint = k === "fg" ? `${Math.round(100 - s.yardLine + 17)} yards` : p.hint;
      return `<button class="call" data-play="${k}"><span>${p.label}</span><small>${hint}</small></button>`;
    }).join("");
    box.querySelectorAll("[data-play]").forEach((b) => { b.onclick = () => callPlay(b.dataset.play); b.onmouseenter = () => SFX.hover(); });
  } else {
    box.innerHTML = Object.entries(DEF_CALLS).filter(([, c]) => !c.when || c.when(s)).map(([k, c]) =>
      `<button class="call def" data-def="${k}"><span>${c.label}</span><small>${c.hint}</small></button>`).join("");
    box.querySelectorAll("[data-def]").forEach((b) => { b.onclick = () => callDefense(b.dataset.def); b.onmouseenter = () => SFX.hover(); });
  }
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
  const hint = $("snap-hint");
  hint.textContent = !onOffense() && !sim.busy && !sim.over && sim.huddle === 0
    ? (sim.s.clockRunning ? `Their offense will snap at about :${String(sim.aiSnapAt).padStart(2, "0")} on the play clock.` : "Their offense is at the line.")
    : "";
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
  const aud = $("sim-audible");
  aud.classList.toggle("hidden", !locked || sim.over);
  aud.textContent = onOffense() ? "Let QB audible" : "Line up in base";
}

function addLog(text, kind = "") {
  sim.log.unshift({ text, kind, clock: fmt(sim.s.clock), q: sim.s.quarter });
  $("sim-log").innerHTML = sim.log.slice(0, 50).map((l) =>
    `<li class="${l.kind}"><span class="log-clock">Q${l.q} ${l.clock}</span>${l.text}</li>`).join("");
}
function note(text, good = false) {
  if (!sim.notes.some((n) => n.text === text)) sim.notes.push({ text, good });
}
function flashSimNote(text) {
  const n = $("sim-note");
  n.textContent = text;
  n.classList.remove("hidden");
  clearTimeout(flashSimNote.t);
  flashSimNote.t = setTimeout(() => n.classList.add("hidden"), 2200);
}

// ---------- Real-time decision clock ----------
function newSnap(playClock = 40) {
  if (sim.over) return;
  sim.pc = playClock;
  sim.huddle = 0;
  sim.usedTO = false;
  sim.busy = false;
  if (!onOffense()) setAiSnap();
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
  if (sim.busy || sim.over || sim.awaitingTry) return;
  if (sim.huddle > 0) {
    sim.huddle--;
    if (sim.huddle === 0) { sim.pc = 25; if (!onOffense()) setAiSnap(); SFX.snap(); }
    renderSimClock();
    return;
  }
  if (!state.clockOn) return;
  sim.pc--;
  if (sim.pc === HEADSET_CUTOFF) SFX.static();
  if (sim.pc <= 5 && sim.pc > 0) SFX.tick();
  if (sim.s.clockRunning) {
    if (runGameClock(1)) return;
    renderScoreboard(simSit(), $("sim-scoreboard"));
  }
  renderSimClock();
  // On defense, their offense snaps when it wants to, whether or not your call is in.
  if (!onOffense() && sim.pc <= Math.max(1, sim.aiSnapAt)) {
    addLog("They snapped before your call got in. Base defense.", "info");
    note("Their offense snapped before your defensive call got in.");
    callDefense("base", true);
    return;
  }
  if (onOffense() && sim.pc <= 0) delayOfGame();
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
    if (!onOffense()) setAiSnap();
    renderSim();
    return false;
  }
  if (s.clock <= 0) { endPeriod(); return true; }
  return false;
}

function simTimeout() {
  if ($("sim-timeout").disabled) return;
  const s = sim.s;
  s.timeouts.us--;
  sim.stats.timeoutsUsed++;
  if (lead(s, "us") > 0 && s.clockRunning && s.quarter === 4) note("Called a timeout while protecting a lead — that stops a clock you want running.");
  if (!s.clockRunning && lead(s, "us") <= 0 && !onOffense()) note(`Used a defensive timeout with the clock already stopped (Q${s.quarter} ${fmt(s.clock)}).`);
  s.clockRunning = false;
  sim.usedTO = true;
  sim.huddle = HUDDLE_SECS;
  addLog(`Timeout, ${onOffense() ? "offense" : "defense"}. You have ${s.timeouts.us} left.`, "info");
  SFX.whistle();
  renderSim();
}
function breakHuddle() {
  if (sim.huddle > 0) { sim.huddle = 0; sim.pc = 25; if (!onOffense()) setAiSnap(); renderSimClock(); }
}

function delayOfGame() {
  const s = sim.s;
  s.yardLine = Math.max(1, s.yardLine - 5);
  s.distance += 5;
  addLog("DELAY OF GAME. 5-yard penalty, replay the down.", "bad");
  note("Took a delay-of-game penalty — no call got in before the play clock expired.");
  SFX.bad();
  if (s.clockRunning && isLate(s) && s.clock <= 60) {
    addLog("10-second runoff.", "bad");
    if (runGameClock(10)) return;
  }
  newSnap(25);
}

function simAudible() {
  if (!simLocked()) return;
  if (!onOffense()) { callDefense("base", true); return; }
  const k = sim.s.clockRunning && lead(sim.s, "us") < 0 ? "quickOut" : chance(0.5) ? "runIn" : "slant";
  addLog(`No call got in. QB audibles to: ${PLAYS[k].label}.`, "info");
  note("Let the headset cut out and had to rely on a QB audible.");
  callPlay(k, true);
}

// ---------- The opponent's play-caller ----------
// Always leave you at least ~10 seconds to get a defensive call in.
function setAiSnap() { sim.aiSnapAt = Math.min(aiTempoSnap(sim.s), sim.pc - 10); }
function aiTempoSnap(s) {
  const d = lead(s, "them");
  if (!s.clockRunning) return 20;
  if (isLate(s) && d < 0 && s.clock <= 300) return 28;   // trailing: hurry
  if (isLate(s) && d > 0) return 2;                      // leading: milk it
  return 12;
}

function aiPlan(s) {
  const d = lead(s, "them");
  const dist = 100 - s.yardLine + 17;
  const late = isLate(s) && s.clock <= 300;
  const pick = (weights) => {
    let x = Math.random(), acc = 0;
    for (const [k, w] of weights) { acc += w; if (x <= acc) return k; }
    return weights[0][0];
  };
  // Tied or down 1-2 in easy range late: drain the clock, then kick it.
  if (s.quarter === 4 && s.clock <= 150 && d <= 0 && d >= -2 && dist <= 42) {
    if (s.down === 4 || s.clock <= 8) return "fg";
    return "kneel";
  }
  if (s.quarter === 2 && s.clock <= 30 && dist <= 50 && (s.down === 4 || s.clock <= 8)) return "fg";
  // Protecting a lead: kneel if it ends the game, otherwise run.
  if (late && d > 0) {
    const k = simulateKneels({ seconds: s.clock, down: s.down, oppTimeouts: s.timeouts.us, clockRunning: s.clockRunning, warningPending: !s.warningUsed && s.clock > 120 });
    if (k.win) return "kneel";
    if (s.down === 4) return dist <= 45 ? "fg" : "punt";
    return pick([["runIn", 0.7], ["runOut", 0.15], ["slant", 0.15]]);
  }
  // Need points late.
  if (late && d <= 0) {
    if (s.down === 4) {
      if (dist <= 55 && d >= -3) return "fg";
      return pick([["slant", 0.4], ["quickOut", 0.3], ["deep", 0.3]]);
    }
    if (s.clock <= 10 && dist <= 50 && d >= -3) return "fg";
    if (s.clock <= 8 && s.yardLine >= 45) return "hail";
    if (s.clockRunning && s.timeouts.them === 0 && s.clock <= 35 && s.down < 4) return "spike";
    return pick([["quickOut", 0.35], ["slant", 0.3], ["deep", 0.2], ["runOut", 0.15]]);
  }
  if (s.down === 4) return s.yardLine < 55 ? "punt" : dist <= 50 ? "fg" : "slant";
  return pick([["runIn", 0.45], ["runOut", 0.15], ["slant", 0.25], ["quickOut", 0.1], ["deep", 0.05]]);
}

// ---------- Snaps ----------
function callPlay(key, audible = false) {
  if (sim.busy || sim.over || !onOffense()) return;
  if (!audible && simLocked()) return;
  const s = sim.s;
  critiqueOffense(key);
  const snapAt = TEMPO_SNAP[sim.tempo];
  executeSnap(key, "base", s.clockRunning ? Math.max(0, sim.pc - snapAt) : 0);
}

function callDefense(defKey, forced = false) {
  if (sim.busy || sim.over || onOffense()) return;
  if (!forced && simLocked()) return;
  const s = sim.s;
  if (defKey === "letScore") {
    executeSnap("letScore", defKey, 0);
    return;
  }
  // Their offense lets the clock run to its preferred snap point.
  let runoff = s.clockRunning ? Math.max(0, sim.pc - sim.aiSnapAt) : 0;
  if (runoff > 0 && lead(s, "us") < 0 && isLate(s) && s.clock <= 300 && s.timeouts.us > 0) sim.wasted += runoff;
  let key = aiPlan(s);
  // Clock-killing field goal: their kicker comes out with a few seconds left, using a timeout if they need one.
  if (key === "fg" && s.clockRunning && s.clock - runoff <= 3) {
    runoff = Math.max(0, s.clock - 3);
    if (s.timeouts.them > 0) { s.timeouts.them--; addLog("Opponent timeout to set up the kick.", "info"); }
  }
  if (key === "kneel" && s.clockRunning && s.clock - runoff <= 3 && s.yardLine + 17 >= 0) {
    key = "fg";
    runoff = Math.max(0, s.clock - 3);
  }
  critiqueDefense(defKey, key);
  executeSnap(key, defKey, runoff);
}

async function executeSnap(key, defKey, runoff) {
  const s = sim.s;
  sim.busy = true;
  stopSimClock();
  lockSimCalls();
  SFX.click();

  if (runoff > 0) {
    const warningBefore = s.warningUsed;
    if (runGameClock(runoff)) return;
    if (!warningBefore && s.warningUsed) { sim.busy = false; newSnap(25); return; }
  }

  let r;
  if (key === "letScore") {
    r = { yards: 100 - s.yardLine, secs: 5, letScore: true, text: "Defense steps aside — they walk into the end zone." };
  } else {
    r = PLAYS[key].run(s, onOffense() ? MOD_BASE : modFor(defKey));
  }
  if (onOffense()) sim.stats.plays++;
  const who = onOffense() ? "" : "Opponent: ";
  if (!onOffense()) addLog(`Your call: ${DEF_CALLS[defKey].label}. They ran: ${key === "letScore" ? "a dive" : PLAYS[key].label}.`, "info");
  addLog(who + r.text, r.int || r.fumble ? (onOffense() ? "bad" : "good") : "");

  // The clock runs during the play once the ball is snapped.
  const startClock = s.clock;
  s.clock = Math.max(0, s.clock - r.secs);
  let warningHit = false;
  if (isLate(s) && !s.warningUsed && startClock > 120 && s.clock <= 120) { s.clock = 120; s.warningUsed = true; warningHit = true; }
  const periodOver = s.clock <= 0;
  renderScoreboard(simSit(), $("sim-scoreboard"));

  await animatePlay($("sim-field"), { key, r, los: s.yardLine, defCall: defKey });
  resolvePlay(r, key, warningHit, periodOver);
}

function resolvePlay(r, key, warningHit, periodOver) {
  const s = sim.s;
  const offense = s.poss, defense = other(offense);
  const good = offense === "us";

  if (r.int || r.fumble) {
    (good ? SFX.bad : SFX.best)();
    banner(r.int ? "INTERCEPTED" : "FUMBLE", good ? "bad" : "best");
    if (!good) sim.stats.stops++;
    const spot = Math.min(99, Math.max(1, s.yardLine + (r.yards || 0)));
    const ret = r.int ? irnd(0, 15) : 0;
    return changePossession(Math.max(1, 100 - spot + ret), periodOver, "turnover");
  }
  if (r.fg) {
    if (r.good) {
      s.score[offense] += 3;
      (good ? SFX.fanfare : SFX.bad)();
      banner("IT'S GOOD!", good ? "best" : "bad");
      return afterScore(periodOver);
    }
    (good ? SFX.bad : SFX.best)();
    banner("NO GOOD", good ? "bad" : "best");
    return changePossession(Math.max(20, 100 - (s.yardLine - 7)), periodOver, "missed field goal");
  }
  if (r.punt) {
    const land = s.yardLine + r.net;
    return changePossession(land >= 100 ? 20 : 100 - land, periodOver, "punt");
  }

  const newYL = s.yardLine + r.yards;
  if (good) sim.stats.yards += r.yards;
  if (newYL >= 100) {
    s.score[offense] += 6;
    (good ? SFX.fanfare : SFX.bad)();
    banner("TOUCHDOWN!", good ? "best" : "bad");
    s.clockRunning = false;
    s.yardLine = 98;
    if (r.letScore) note(`Let them score with ${fmt(s.clock)} left to get the ball back.`, lead(s, "us") >= -7);
    if (good) {
      sim.awaitingTry = true;
      sim.busy = false;
      renderSim();
      return;
    }
    return runTry("them", aiTryChoice(s));
  }
  if (newYL <= 0) {
    s.score[defense] += 2;
    (good ? SFX.bad : SFX.best)();
    banner("SAFETY", good ? "bad" : "best");
    s.poss = defense; // the team that scored a safety receives the free kick
    return changePossession(40, periodOver, "free kick after a safety", true);
  }
  s.yardLine = newYL;
  let firstDown = false;
  if (r.yards >= s.distance) {
    s.down = 1; firstDown = true;
    s.distance = Math.min(10, 100 - s.yardLine);
  } else {
    s.down++; s.distance -= r.yards;
  }
  if (s.down > 4) {
    (good ? SFX.bad : SFX.best)();
    banner("TURNOVER ON DOWNS", good ? "bad" : "best");
    addLog("Turnover on downs.", good ? "bad" : "good");
    if (!good) sim.stats.stops++;
    return changePossession(100 - s.yardLine, periodOver, "downs");
  }
  if (r.yards >= 10) (good ? SFX.best : SFX.bad)(); else if (r.inc || r.sack) (good ? SFX.ok : SFX.best)(); else SFX.click();

  // Clock after the play.
  const finalMinutes = (s.quarter === 4 && s.clock <= 300) || (s.quarter === 2 && s.clock <= 120);
  if (r.inc) s.clockRunning = false;
  else if (r.oob) s.clockRunning = !finalMinutes;
  else s.clockRunning = true;
  if (warningHit) { s.clockRunning = false; addLog("Two-minute warning.", "info"); }
  let chainStop = false;
  if (s.league === "cfb" && firstDown && s.clockRunning && s.clock <= 120 && isLate(s)) {
    chainStop = true;
    addLog("First down — clock stops while the chains move (college rule).", "info");
  }
  if (periodOver) return endPeriod();

  // The opponent's timeouts: they stop the clock when they're trailing late.
  const them = "them";
  if (s.clockRunning && isLate(s) && s.clock <= 300 && lead(s, them) < 0 && s.timeouts.them > 0) {
    s.timeouts.them--;
    s.clockRunning = false;
    addLog(`Opponent timeout (${offense === them ? "offense" : "defense"}). They have ${s.timeouts.them} left.`, "info");
  }
  sim.busy = false;
  if (chainStop) {
    s.clockRunning = false;
    newSnap(40);
    setTimeout(() => { if (!sim.over && !sim.busy && !sim.usedTO && sim.huddle === 0) { s.clockRunning = true; renderScoreboard(simSit(), $("sim-scoreboard")); } }, 2500);
    return;
  }
  newSnap(warningHit ? 25 : 40);
}

function aiTryChoice(s) {
  const d = lead(s, "them"); // after the touchdown, before the try
  return [-2, -5, -8, 1, 5].includes(d) ? "two" : "pat";
}

function runTry(team, kind) {
  const s = sim.s;
  const good = kind === "pat" ? chance(s.league === "cfb" ? 0.98 : 0.94) : chance(0.48);
  const diffBefore = lead(s, team);
  if (good) s.score[team] += kind === "pat" ? 1 : 2;
  const label = `${team === "us" ? "" : "Opponent "}${kind === "pat" ? "extra point" : "two-point try"} ${good ? "is GOOD" : "FAILS"}.`;
  addLog(label.charAt(0).toUpperCase() + label.slice(1), (team === "us") === good ? "good" : "bad");
  if (team === "us") {
    (good ? SFX.best : SFX.bad)();
    banner(good ? (kind === "pat" ? "PAT GOOD" : "2-POINT GOOD!") : "NO GOOD", good ? "best" : "bad");
    const goFor2 = [-2, -5, -8, 1, 5].includes(diffBefore);
    if (goFor2 && kind === "pat") note(`Kicked the PAT ${diffBefore < 0 ? "down" : "up"} ${Math.abs(diffBefore)} after the TD — the chart says go for two there.`);
    if (goFor2 && kind === "two") note(`Went for two ${diffBefore < 0 ? "down" : "up"} ${Math.abs(diffBefore)} — the right side of the chart.`, true);
    sim.awaitingTry = false;
  }
  setTimeout(() => afterScore(s.clock <= 0), team === "us" ? 0 : 900);
}

function afterScore(periodOver) {
  const s = sim.s;
  if (periodOver || s.clock <= 0) return endPeriod();
  // Kickoff: the team that scored kicks; the other team starts at its 25.
  changePossession(25, false, "kickoff");
}

// newYardLine is from the new offense's point of view.
function changePossession(newYardLine, periodOver, why, alreadyFlipped = false) {
  const s = sim.s;
  if (periodOver || s.clock <= 0) return endPeriod();
  if (!alreadyFlipped) s.poss = other(s.poss);
  s.yardLine = Math.min(99, Math.max(1, Math.round(newYardLine)));
  s.down = 1;
  s.distance = Math.min(10, 100 - s.yardLine);
  s.clockRunning = false;
  const mine = s.poss === "us";
  addLog(`${mine ? "Your" : "Their"} ball (${why}) at ${mine ? "your" : "their"} ${s.yardLine <= 50 ? "own " + s.yardLine : "opponent's " + (100 - s.yardLine)}.`, "info");
  flashSimNote(mine ? "Your offense is up" : "Defense, take the field");
  sim.busy = true;
  setTimeout(() => newSnap(40), 1200);
}

function banner(text, grade) { showBanner(text, grade, 0); }

// ---------- Coaching critiques ----------
function critiqueOffense(key) {
  const s = sim.s;
  const late4 = s.quarter === 4 && s.clock <= 300;
  const d = lead(s, "us");
  if (late4 && d < 0 && s.clockRunning && sim.tempo === "milk") note(`Milked the clock while trailing (Q4 ${fmt(s.clock)}).`);
  if (late4 && d > 0 && s.clockRunning && sim.tempo === "fast") note(`Hurried to the line while protecting a lead (Q4 ${fmt(s.clock)}).`);
  if (late4 && d > 0 && ["quickOut", "deep", "hail"].includes(key)) note(`Threw a clock-stopping pass with the lead (Q4 ${fmt(s.clock)}).`);
  if (late4 && d > 0 && key === "kneel") note("Took a knee to drain the clock with the lead.", true);
  if (d < 0 && key === "kneel") note("Knelt while trailing.");
  if (key === "spike" && s.timeouts.us > 0 && s.clock > 30) note(`Spiked with ${s.timeouts.us} timeout${s.timeouts.us > 1 ? "s" : ""} left and ${fmt(s.clock)} to play — a timeout would have saved the down.`);
  if (key === "fg" && s.quarter === 4 && d < -3) note(`Kicked a field goal down ${-d} late — it doesn't tie or win.`);
  if (key === "punt" && s.quarter === 4 && d < 0 && s.clock < 150) note(`Punted while trailing with ${fmt(s.clock)} left.`);
  if (key === "quickOut" && d < 0 && late4) note("Used the sideline to manage the clock while trailing.", true);
}

function critiqueDefense(defKey, aiKey) {
  const s = sim.s;
  const d = lead(s, "us");
  const dist = 100 - s.yardLine + 17;
  if (defKey === "prevent" && d > 0 && d <= 3 && dist <= 50) note(`Played prevent while they were already in field-goal range (${dist}-yarder) — a field goal ties it.`);
  if (defKey === "prevent" && d > 3 && d <= 8 && s.quarter === 4 && s.clock <= 90) note("Played prevent when they needed a touchdown: the sideline and the end zone were what mattered.", true);
  if (defKey === "box" && ["runIn", "runOut", "kneel"].includes(aiKey) && d < 0) note("Stacked the box against a team trying to run out the clock.", true);
  if (defKey === "blitz" && s.quarter === 4 && d > 0 && d <= 3 && s.clock <= 60 && 100 - s.yardLine <= 45) note("Blitzed with the lead late, risking a big play into field-goal range.");
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
  const d = lead(s, "us");
  const start = sim.drive.start.score;
  let head, grade;
  if (s.quarter === 2) {
    const net = (s.score.us - start.us) - (s.score.them - start.them);
    head = net > 0 ? `Halftime: +${net} for you` : net < 0 ? `Halftime: you gave up ${-net}` : "Halftime: no damage either way";
    grade = net > 0 ? "best" : net === 0 ? "ok" : "bad";
  } else {
    head = d > 0 ? "FINAL — YOU WIN" : d < 0 ? "FINAL — YOU LOSE" : "END OF REGULATION — HEADED TO OVERTIME";
    grade = d > 0 ? "best" : d === 0 ? "ok" : "bad";
  }
  if (s.quarter === 4 && d < 0 && s.timeouts.us > 0) note(`Finished trailing with ${s.timeouts.us} timeout${s.timeouts.us > 1 ? "s" : ""} unused.`);
  if (sim.wasted >= 30) note(`Let about ${fmt(sim.wasted)} run off on defense while trailing with timeouts in your pocket.`);
  (grade === "best" ? SFX.fanfare : grade === "ok" ? SFX.ok : SFX.gameOver)();
  stopMusic();
  addLog(head, grade === "bad" ? "bad" : "good");
  banner(grade === "best" ? "VICTORY" : grade === "ok" ? (s.quarter === 2 ? "HALFTIME" : "OVERTIME") : "DEFEAT", grade);

  const goodN = sim.notes.filter((n) => n.good), badN = sim.notes.filter((n) => !n.good);
  $("sim-end").innerHTML = `
    <h2 class="sim-end-head ${grade}">${head}</h2>
    <p class="sim-score">Final score: You ${s.score.us}, Opponent ${s.score.them}</p>
    <div class="stats">
      <div class="stat"><span class="stat-label">Your offensive plays</span><span class="stat-value">${sim.stats.plays}</span></div>
      <div class="stat"><span class="stat-label">Your yards</span><span class="stat-value">${sim.stats.yards}</span></div>
      <div class="stat"><span class="stat-label">Defensive stops</span><span class="stat-value">${sim.stats.stops}</span></div>
      <div class="stat"><span class="stat-label">Timeouts used</span><span class="stat-value">${sim.stats.timeoutsUsed}</span></div>
    </div>
    <h3>Film room</h3>
    <ul class="film">${[...badN.map((n) => `<li class="bad">✗ ${n.text}</li>`), ...goodN.map((n) => `<li class="good">✓ ${n.text}</li>`)].join("") || "<li>Clean game management. No red flags.</li>"}</ul>
    <p class="fine">Play outcomes are randomized with game-style odds, so the same calls can play out differently. Judge the calls in the film room, not just the scoreboard.</p>
    <div class="btn-row">
      <button class="primary" id="sim-again">▶ Run it back</button>
      <button class="primary alt" id="sim-menu">Other drives</button>
    </div>`;
  $("sim-end").classList.remove("hidden");
  $("sim-panel").classList.add("hidden");
  $("sim-again").onclick = () => startDrive(sim.drive.id);
  $("sim-menu").onclick = () => { renderHome(); $("sim-menu-card").scrollIntoView(); };
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
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopSimClock();
  else if (!$("sim").classList.contains("hidden") && !sim.over && !sim.busy && !sim.timer) sim.timer = setInterval(simTick, 1000);
});
document.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", stopSimClock));
renderSimMenu();
