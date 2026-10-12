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

// ---------- Defensive calls ----------
// In NFL mode each call draws from real plays run against that look (FTN charting via
// nflverse, 2023-25): blitz = 5+ pass rushers, Cover 2 = Cover 2 / 2-man, stacked box = 8+
// in the box, prevent = zone with 4 or fewer rushers in the final 2:00 while leading by 4-16.
// College data has no charting, so college applies the NFL effect sizes as a tilt.
const DEF_CALLS = {
  base: { label: "Base defense", hint: "Balanced: every real play of this type" },
  box: { label: "Stack the box", hint: "8+ in the box: tougher runs" },
  blitz: { label: "Blitz", hint: "5+ rushers: more sacks, more big plays" },
  cover2: { label: "Cover 2", hint: "Two deep safeties, squeezes the sideline" },
  prevent: { label: "Prevent", hint: "Soft zone: concede short, take away deep" },
  letScore: { label: "Let them score", hint: "Get the ball back with time on the clock", when: (s) => s.yardLine >= 88 },
};

// ---------- Real plays ----------
const PASS_CATS = ["quickOut", "slant", "deep", "hail"];
const INT_DEPTH = { quickOut: 6, slant: 9, deep: 25, hail: 40 };
const VERB = { runIn: "Run up the middle", runOut: "Run to the outside", quickOut: "Quick out", slant: "Slant", deep: "Deep shot", hail: "Hail Mary" };

// Team strength tilts which real plays get drawn: weight = exp(beta * EPA), where beta is
// the offense's EPA/play edge over average plus the defense's EPA/play allowed over average.
function teamBeta(kind) {
  const s = sim.s;
  if (s.league !== "nfl" || !sim.teams) return 0;
  const T = NFL_DATA.teams, o = T[sim.teams[s.poss]], d = T[sim.teams[other(s.poss)]];
  if (!o || !d) return 0;
  const delta = kind === "pass" ? o.offPass + d.defPass : o.offRun + d.defRun;
  return delta / NFL_DATA.epaVar;
}
function weightedPick(list, beta) {
  if (!beta) return list[Math.floor(Math.random() * list.length)];
  const w = list.map((p) => Math.exp(beta * Math.max(-3, Math.min(3, p[2] || 0))));
  let x = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) { x -= w[i]; if (x <= 0) return list[i]; }
  return list[list.length - 1];
}

function realPlay(cat, defCall) {
  const s = sim.s;
  const L = leagueData(s.league);
  const isPass = PASS_CATS.includes(cat);
  const call = defCall && defCall !== "base" ? defCall : null;
  if (isPass && cat !== "hail") {
    let rate = (call && L.sackRate[call]) || L.sackRate.all;
    if (s.league === "cfb" && call && NFL_DATA.sackRate[call]) rate = L.sackRate.all * NFL_DATA.sackRate[call] / NFL_DATA.sackRate.all;
    if (Math.random() < rate) return toResult(weightedPick(L.sacks, 0), "sack");
  }
  const bank = L.bank[cat] || L.bank.deep;
  let list = (s.league === "nfl" && call && bank[call]) || bank.all;
  let beta = teamBeta(isPass ? "pass" : "run");
  if (s.league === "cfb" && call) {
    const r = NFL_DATA.rates[cat];
    if (r && r[call]) beta += (r[call].epa - r.all.epa) / NFL_DATA.epaVar;
  }
  return toResult(weightedPick(list, beta), cat);
}

function toResult([yards, flags, epa, desc], cat) {
  const s = sim.s;
  const r = { yards, inc: !!(flags & 1), int: !!(flags & 2), fumble: !!(flags & 4), oob: !!(flags & 8), realDesc: desc, realEpa: epa };
  const toGo = 100 - s.yardLine;
  if (cat === "sack") {
    r.sack = true;
    r.yards = Math.min(-1, yards);
    r.secs = 4;
    r.text = r.fumble ? "SACKED and the ball comes loose! Defense recovers." : `SACKED for a loss of ${-r.yards}.`;
    return r;
  }
  r.secs = r.inc ? (cat === "deep" || cat === "hail" ? 6 : 4) : cat === "deep" || cat === "hail" ? 7 : 6;
  if (r.int) {
    r.yards = Math.min(toGo - 1, INT_DEPTH[cat] || 8);
    r.text = `${VERB[cat]} — INTERCEPTED!`;
    return r;
  }
  if (r.inc) { r.yards = 0; r.text = `${VERB[cat]}, incomplete.`; return r; }
  r.yards = Math.min(toGo, yards);
  const gain = r.yards >= toGo ? "TOUCHDOWN" : `${r.yards >= 0 ? "a gain of" : "a loss of"} ${Math.abs(r.yards)}`;
  r.text = `${VERB[cat]}${PASS_CATS.includes(cat) ? " complete" : ""} for ${gain}${r.oob && r.yards < toGo ? ", out of bounds" : ""}${r.fumble ? " — FUMBLE, defense recovers!" : "."}`;
  return r;
}

const PLAYS = {
  runIn: { label: "Run inside", hint: "Real inside runs: steady, keeps the clock running", run: (s, d) => realPlay("runIn", d) },
  runOut: { label: "Run outside", hint: "Real runs to the edge: can get out of bounds", run: (s, d) => realPlay("runOut", d) },
  quickOut: { label: "Quick out", hint: "Short sideline throws (air yards ≤ 9)", run: (s, d) => realPlay("quickOut", d) },
  slant: { label: "Slant / middle", hint: "Throws over the middle (air yards ≤ 14)", run: (s, d) => realPlay("slant", d) },
  deep: { label: "Deep shot", hint: "Throws 20+ yards downfield", run: (s, d) => realPlay("deep", d) },
  hail: { label: "Hail Mary", hint: "Real 40+ yard heaves at the end of a half", when: (s) => s.yardLine >= 45,
    run: (s, d) => {
      const r = realPlay(sim.s.league === "nfl" ? "hail" : "deep", d);
      if (!r.inc && !r.int && !r.sack) { r.yards = 100 - s.yardLine; r.text = "HAIL MARY... CAUGHT! TOUCHDOWN!"; }
      return r;
    } },
  spike: { label: "Spike", hint: "Stops the clock, costs a down", when: (s) => s.clockRunning && s.down < 4,
    run: () => ({ inc: true, spike: true, yards: 0, secs: 1, text: "Spiked to stop the clock." }) },
  kneel: { label: "Kneel", hint: "Lose a yard, keep the clock running",
    run: () => ({ yards: -1, secs: 2, kneel: true, text: "Victory formation. Kneel." }) },
  fg: { label: "Field goal", hint: "", when: (s) => 100 - s.yardLine + 17 <= 66,
    run: (s) => {
      const dist = Math.round(100 - s.yardLine + 17);
      const good = Math.random() < fgProb(dist, s.league);
      return { fg: true, good, dist, secs: 4, text: `${dist}-yard field goal is ${good ? "GOOD!" : "NO GOOD."}` };
    } },
  punt: { label: "Punt", hint: "Real net punt distances", when: (s) => s.yardLine < 65,
    run: (s) => {
      const nets = leagueData(s.league).kick.puntNet;
      return { punt: true, net: nets[Math.floor(Math.random() * nets.length)], secs: 8, text: "Punt away." };
    } },
};

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
const gameSecs = (s) => (s.quarter === 2 ? s.clock + 1800 : s.clock);
const epAt = (s, down, dist, yardLine) => expectedPoints(down, dist, 100 - yardLine, s.league);

// Our win probability right now, from the real-data model in model.js.
function ourWP() {
  const s = sim.s;
  const secs = gameSecs(s);
  if (sim.awaitingTry) return tryValues({ diffAfterTD: lead(s, "us"), secs, posTO: s.timeouts.us, defTO: s.timeouts.them }, s.league).pat;
  const st = { secs, down: s.down, dist: s.distance, yl100: 100 - s.yardLine };
  return s.poss === "us"
    ? winProb({ ...st, diff: lead(s, "us"), posTO: s.timeouts.us, defTO: s.timeouts.them }, s.league)
    : 1 - winProb({ ...st, diff: lead(s, "them"), posTO: s.timeouts.them, defTO: s.timeouts.us }, s.league);
}
function renderWP() {
  if (!sim.s) return;
  const wp = sim.over ? (lead(sim.s, "us") > 0 ? 1 : lead(sim.s, "us") < 0 ? 0 : 0.5) : ourWP();
  $("sim-wp-fill").style.width = `${(wp * 100).toFixed(1)}%`;
  $("sim-wp-num").textContent = `${Math.round(wp * 100)}%`;
  $("sim-wp").classList.toggle("low", wp < 0.3);
  $("sim-wp").classList.toggle("high", wp > 0.7);
}

// ---------- Teams (NFL): real colors and EPA ratings ----------
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return 0.5;
  const n = parseInt(m[1], 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function applyTeamColors() {
  const root = $("sim");
  ["us", "them"].forEach((side) => {
    const t = sim.teams && NFL_DATA.teams[sim.teams[side]];
    if (!t) { ["", "-ink", "-text"].forEach((x) => root.style.removeProperty(`--${side}${x}`)); return; }
    root.style.setProperty(`--${side}`, t.color);
    root.style.setProperty(`--${side}-ink`, luminance(t.color) < 0.35 ? "#fff" : "#000");
    const text = luminance(t.color) > 0.12 ? t.color : luminance(t.color2) > 0.12 ? t.color2 : "#fff";
    root.style.setProperty(`--${side}-text`, text);
  });
}
function renderTeamPickers() {
  const nfl = state.league === "nfl";
  $("team-pickers").classList.toggle("hidden", !nfl);
  if (!nfl) return;
  const opts = Object.entries(NFL_DATA.teams).sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([k, t]) => `<option value="${k}">${t.name}</option>`).join("");
  ["team-us", "team-them"].forEach((id, i) => {
    const sel = $(id);
    const keep = sel.value || loadPref(`headset-${id}`) || (i === 0 ? "KC" : "BUF");
    sel.innerHTML = opts;
    sel.value = NFL_DATA.teams[keep] ? keep : Object.keys(NFL_DATA.teams)[i];
    sel.onchange = () => { savePref(`headset-${id}`, sel.value); renderTeamBlurb(); };
  });
  renderTeamBlurb();
}
function renderTeamBlurb() {
  const T = NFL_DATA.teams, a = T[$("team-us").value], b = T[$("team-them").value];
  if (!a || !b) return;
  const f = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  $("team-blurb").textContent = `EPA/play vs. average (2025 + 2026 so far) · ${a.nick}: pass ${f(a.offPass)}, run ${f(a.offRun)} on offense; ${f(-a.defPass)} / ${f(-a.defRun)} on defense. ${b.nick}: pass ${f(b.offPass)}, run ${f(b.offRun)}; ${f(-b.defPass)} / ${f(-b.defRun)} on defense.`;
}

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
  sim.teams = state.league === "nfl" ? { us: $("team-us").value, them: $("team-them").value } : null;
  if (sim.teams && sim.teams.us === sim.teams.them) sim.teams = null;
  applyTeamColors();
  const st = JSON.parse(JSON.stringify(d.start));
  sim.s = { down: 1, distance: 10, ...st, league: state.league, warningUsed: st.clock <= 120 };
  Object.assign(sim, { log: [], notes: [], over: false, busy: false, awaitingTry: false, tempo: "normal", wasted: 0,
    stats: { plays: 0, yards: 0, timeoutsUsed: 0, stops: 0 },
    epaOff: 0, offPlays: 0, epaDef: 0, defPlays: 0, swings: [], wpHist: [], pending: null });
  const T = sim.teams && NFL_DATA.teams;
  $("sim-title").textContent = `${d.title} · ${T ? `${T[sim.teams.us].nick} vs ${T[sim.teams.them].nick}` : `${LEAGUE_NAME[state.league]} rules`}`;
  sim.wpHist.push(ourWP());
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
    teams: sim.teams ? { us: sim.teams.us, them: sim.teams.them } : undefined,
  };
}
function renderSim() {
  const sit = simSit();
  renderScoreboard(sit, $("sim-scoreboard"));
  renderField(sit, $("sim-field"));
  renderCalls();
  renderSimClock();
  renderWP();
}

function renderCalls() {
  const s = sim.s;
  const box = $("sim-calls");
  $("sim-side").textContent = onOffense() ? "You're on offense" : "You're on defense";
  $("sim-side").className = `side-tag ${onOffense() ? "off" : "def"}`;
  $("tempo-wrap").classList.toggle("hidden", !onOffense() || sim.awaitingTry);
  if (sim.awaitingTry) {
    const tv = tryValues({ diffAfterTD: lead(s, "us"), secs: gameSecs(s), posTO: s.timeouts.us, defTO: s.timeouts.them }, s.league);
    box.innerHTML = `
      <button class="call" data-try="pat"><span>Kick the PAT</span><small>${Math.round(leagueData(s.league).kick.xp * 100)}%, 1 point · win prob ${pct(tv.pat)}</small></button>
      <button class="call" data-try="two"><span>Go for two</span><small>${Math.round((leagueData(s.league).kick.two || NFL_DATA.kick.two) * 100)}%, 2 points · win prob ${pct(tv.two)}</small></button>`;
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

function addLog(text, kind = "", extra = {}) {
  sim.log.unshift({ text, kind, clock: fmt(sim.s.clock), q: sim.s.quarter, ...extra });
  renderLog();
  return sim.log[0];
}
function renderLog() {
  $("sim-log").innerHTML = sim.log.slice(0, 60).map((l) =>
    `<li class="${l.kind}"><span class="log-clock">Q${l.q} ${l.clock}</span>${l.text}${l.real ? `<span class="log-real">Real play: ${l.real}</span>` : ""}${l.meta ? `<span class="log-meta">${l.meta}</span>` : ""}</li>`).join("");
}

// Each snap's EPA and win-probability change are settled at the next snap, once kickoffs,
// tries and possession changes have played out.
function finalizePlay() {
  const p = sim.pending;
  if (!p) return;
  sim.pending = null;
  const wpAfter = sim.over ? (lead(sim.s, "us") > 0 ? 1 : lead(sim.s, "us") < 0 ? 0 : 0.5) : ourWP();
  const dwp = wpAfter - p.wp;
  if (p.off === "us") { sim.epaOff += p.epa; sim.offPlays++; } else { sim.epaDef += p.epa; sim.defPlays++; }
  sim.wpHist.push(wpAfter);
  sim.swings.push({ dwp, text: p.text, q: p.q, clock: p.clock });
  const goodForUs = (p.off === "us") === (p.epa >= 0);
  p.entry.meta = `<b class="${goodForUs ? "pos" : "neg"}">${p.off === "us" ? "Your" : "Their"} EPA ${signed(p.epa)}</b> · win probability ${pct(wpAfter)} <b class="${dwp >= 0 ? "pos" : "neg"}">(${signed(dwp * 100, 1)})</b>`;
  renderLog();
  renderWP();
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
  finalizePlay();
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
    if (s.down === 4) return aiFourth(s);
    return pick([["runIn", 0.7], ["runOut", 0.15], ["slant", 0.15]]);
  }
  // Need points late.
  if (late && d <= 0) {
    if (s.down === 4) return aiFourth(s);
    if (s.clock <= 10 && dist <= 50 && d >= -3) return "fg";
    if (s.clock <= 8 && s.yardLine >= 45) return "hail";
    if (s.clockRunning && s.timeouts.them === 0 && s.clock <= 35 && s.down < 4) return "spike";
    return pick([["quickOut", 0.35], ["slant", 0.3], ["deep", 0.2], ["runOut", 0.15]]);
  }
  if (s.down === 4) return aiFourth(s);
  return pick([["runIn", 0.45], ["runOut", 0.15], ["slant", 0.25], ["quickOut", 0.1], ["deep", 0.05]]);
}

// 4th-down decisions are graded with the win-probability model built from real play-by-play.
const FOURTH_LABEL = { go: "going for it", punt: "punting", fg: "a field goal" };
function fourthValues(team) {
  const s = sim.s;
  return fourthDownValues({ diff: lead(s, team), secs: gameSecs(s), dist: s.distance, yl100: 100 - s.yardLine,
    posTO: s.timeouts[team], defTO: s.timeouts[other(team)] }, s.league);
}
function gradeFourth(key) {
  const s = sim.s;
  const choice = key === "punt" ? "punt" : key === "fg" ? "fg" : "go";
  const { values, conv } = fourthValues("us");
  if (!(choice in values)) return;
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const [bestKey, bestVal] = entries[0];
  const where = `4th & ${s.distance} at ${spotText(Math.round(s.yardLine))} (Q${s.quarter} ${fmt(s.clock)})`;
  addLog(`Model win probability: ${entries.map(([k, v]) => `${k === "go" ? "Go" : k === "punt" ? "Punt" : "FG"} ${pct(v)}`).join(" · ")}. 4th & ${s.distance} converts ${Math.round(conv * 100)}% in real data.`, "info");
  if (values[choice] < bestVal - 0.01) note(`${where}: chose ${FOURTH_LABEL[choice]} (${pct(values[choice])} win probability). The model favored ${FOURTH_LABEL[bestKey]} at ${pct(bestVal)}.`);
  else if (entries.length > 1 && bestVal - entries[1][1] > 0.01) note(`${where}: chose ${FOURTH_LABEL[choice]}, the model's best option (${pct(bestVal)}).`, true);
}
function aiFourth(s) {
  const { values } = fourthValues("them");
  const ranked = Object.entries(values).sort((a, b) => b[1] - a[1]);
  // Real coaches are a little conservative: they take the model's call about 80% of the time.
  let pickKey = ranked[0][0];
  if (pickKey === "go" && ranked.length > 1 && Math.random() < 0.2) pickKey = ranked[1][0];
  if (pickKey === "punt") return "punt";
  if (pickKey === "fg") return "fg";
  return s.distance <= 2 && Math.random() < 0.55 ? "runIn" : s.distance >= 8 ? "deep" : "slant";
}

// ---------- Snaps ----------
function callPlay(key, audible = false) {
  if (sim.busy || sim.over || !onOffense()) return;
  if (!audible && simLocked()) return;
  const s = sim.s;
  critiqueOffense(key);
  if (s.down === 4) gradeFourth(key);
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
    r = PLAYS[key].run(s, onOffense() ? null : defKey);
  }
  if (onOffense()) sim.stats.plays++;
  sim.pending = { off: s.poss, ep: epAt(s, s.down, s.distance, s.yardLine), wp: ourWP(), q: s.quarter, clock: fmt(s.clock), epa: 0, text: "" };
  const who = onOffense() ? "" : "Opponent: ";
  if (!onOffense()) addLog(`Your call: ${DEF_CALLS[defKey].label}. They ran: ${key === "letScore" ? "a dive" : PLAYS[key].label}.`, "info");
  sim.pending.text = who + r.text;
  sim.pending.entry = addLog(who + r.text, r.int || r.fumble ? (onOffense() ? "bad" : "good") : "", { real: r.realDesc });

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
  // EPA for the offense: expected points after the play (or points scored, or minus the
  // other team's expected points after a change of possession) minus expected points before.
  const epa = (v) => { if (sim.pending) sim.pending.epa = v - sim.pending.ep; };
  const oppEP = (theirYardLine) => -epAt(s, 1, 10, theirYardLine);

  if (r.int || r.fumble) {
    (good ? SFX.bad : SFX.best)();
    banner(r.int ? "INTERCEPTED" : "FUMBLE", good ? "bad" : "best");
    if (!good) sim.stats.stops++;
    const spot = Math.min(99, Math.max(1, s.yardLine + (r.yards || 0)));
    const ret = r.int ? irnd(0, 15) : 0;
    epa(oppEP(Math.max(1, 100 - spot + ret)));
    return changePossession(Math.max(1, 100 - spot + ret), periodOver, "turnover");
  }
  if (r.fg) {
    if (r.good) {
      epa(3);
      s.score[offense] += 3;
      (good ? SFX.fanfare : SFX.bad)();
      banner("IT'S GOOD!", good ? "best" : "bad");
      return afterScore(periodOver);
    }
    (good ? SFX.bad : SFX.best)();
    banner("NO GOOD", good ? "bad" : "best");
    epa(oppEP(Math.max(20, 100 - (s.yardLine - 7))));
    return changePossession(Math.max(20, 100 - (s.yardLine - 7)), periodOver, "missed field goal");
  }
  if (r.punt) {
    const land = s.yardLine + r.net;
    epa(oppEP(land >= 100 ? 20 : 100 - land));
    return changePossession(land >= 100 ? 20 : 100 - land, periodOver, "punt");
  }

  const newYL = s.yardLine + r.yards;
  if (good) sim.stats.yards += r.yards;
  if (newYL >= 100) {
    epa(6 + leagueData(s.league).kick.xp);
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
    epa(-2);
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
    epa(oppEP(100 - s.yardLine));
    return changePossession(100 - s.yardLine, periodOver, "downs");
  }
  epa(epAt(s, s.down, s.distance, s.yardLine));
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
  const K = leagueData(s.league).kick;
  const good = Math.random() < (kind === "pat" ? K.xp : K.two || NFL_DATA.kick.two);
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
  finalizePlay();
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
      <div class="stat"><span class="stat-label">Your offense EPA</span><span class="stat-value ${sim.epaOff >= 0 ? "pos" : "neg"}">${signed(sim.epaOff, 1)}${sim.offPlays ? ` <small>(${signed(sim.epaOff / sim.offPlays)}/play)</small>` : ""}</span></div>
      <div class="stat"><span class="stat-label">EPA allowed on defense</span><span class="stat-value ${sim.epaDef <= 0 ? "pos" : "neg"}">${signed(sim.epaDef, 1)}${sim.defPlays ? ` <small>(${signed(sim.epaDef / sim.defPlays)}/play)</small>` : ""}</span></div>
    </div>
    <h3>Win probability</h3>
    ${wpChart(sim.wpHist)}
    <ul class="swings">${[...sim.swings].sort((a, b) => Math.abs(b.dwp) - Math.abs(a.dwp)).slice(0, 3)
      .map((w) => `<li><b class="${w.dwp >= 0 ? "pos" : "neg"}">${signed(w.dwp * 100, 1)} pts</b> Q${w.q} ${w.clock}: ${w.text}</li>`).join("")}</ul>
    <h3>Film room</h3>
    <ul class="film">${[...badN.map((n) => `<li class="bad">✗ ${n.text}</li>`), ...goodN.map((n) => `<li class="good">✓ ${n.text}</li>`)].join("") || "<li>Clean game management. No red flags.</li>"}</ul>
    <p class="fine">Every snap was drawn from real ${s.league === "cfb" ? "college (cfbfastR 2024–25)" : "NFL (nflverse 2023–25)"} plays of that type${s.league === "nfl" ? ", matched to your defensive call using FTN charting" : ""}${sim.teams ? ", weighted by each team's real EPA per play" : ""}. EPA and win probability come from models fit to the same data. The same calls can still play out differently, so judge the calls in the film room, not just the scoreboard.</p>
    <div class="btn-row">
      <button class="primary" id="sim-again">▶ Run it back</button>
      <button class="primary alt" id="sim-menu">Other drives</button>
    </div>`;
  $("sim-end").classList.remove("hidden");
  $("sim-panel").classList.add("hidden");
  $("sim-again").onclick = () => startDrive(sim.drive.id);
  $("sim-menu").onclick = () => { renderHome(); $("sim-menu-card").scrollIntoView(); };
}

function wpChart(hist) {
  if (hist.length < 2) return "";
  const W = 320, H = 90;
  const pts = hist.map((v, i) => `${(i / (hist.length - 1)) * W},${(1 - v) * H}`).join(" ");
  return `<svg class="wp-chart" viewBox="-4 -4 ${W + 8} ${H + 8}" role="img" aria-label="Your win probability over the drive, from ${pct(hist[0])} to ${pct(hist[hist.length - 1])}">
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="mid"/>
    <polyline points="${pts}" class="line"/>
    <circle cx="${W}" cy="${(1 - hist[hist.length - 1]) * H}" r="4" class="dot"/>
  </svg>`;
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
renderTeamPickers();
document.querySelectorAll("[data-league]").forEach((b) => b.addEventListener("click", renderTeamPickers));
