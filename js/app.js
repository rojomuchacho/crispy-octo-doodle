// Arcade scoring: accuracy points + speed bonus, multiplied while on a streak.
const POINTS = { best: 100, ok: 50, bad: 0 };
const GRADE_LABEL = { best: "BEST", ok: "OK", bad: "MISS" };
const BANNER = { best: "GREAT CALL!", ok: "NOT BAD", bad: "FLAG!", timeout: "DELAY OF GAME" };
const GAME_LENGTH = 10;
const PLAY_CLOCK_SECS = 40;      // after a normal play
const PLAY_CLOCK_SHORT = 25;     // after a timeout or the two-minute warning
const HEADSET_CUTOFF = 15;       // coach-to-player radio shuts off at :15 on the play clock
const HUDDLE_SECS = 30;          // thinking time while your timeout is on
const STREAK_FOR_BONUS = 3;
const LEAGUE_NAME = { nfl: "NFL", cfb: "College" };

const $ = (id) => document.getElementById(id);
const pct = (p) => `${(p * 100).toFixed(1)}%`;
const signed = (x, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  league: loadPref("headset-league") || "nfl",
  clockOn: loadPref("headset-clock") !== "off",
  soundOn: loadPref("headset-sound") !== "off",
  musicOn: loadPref("headset-music") !== "off",
  mode: "random",
  queue: [], index: 0, score: 0, streak: 0, bestStreak: 0, results: [],
  timer: null, timeLeft: PLAY_CLOCK_SECS, answered: false,
  live: null,          // live copy of the situation: game clock, timeouts
  gameSecs: null,      // game clock in seconds while it is running
  huddle: 0,           // seconds left in a timeout huddle
  timeoutsUsed: 0,
};

function loadPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
const bestKey = () => `headset-hiscore-${state.league}`;
const loadBest = () => Number(loadPref(bestKey())) || 0;
function saveBest(score) { if (score > loadBest()) savePref(bestKey(), String(score)); }

const leaguePool = () => SCENARIOS.filter((s) => !s.leagues || s.leagues.includes(state.league));
const realPool = () => REAL_MOMENTS.filter((m) => m.league === state.league);
const autoPool = () => AUTO_MOMENTS.filter((m) => m.league === state.league).map(autoToScenario);
const DATA_SOURCE = {
  nfl: "https://github.com/nflverse/nflverse-data",
  cfb: "https://github.com/sportsdataverse/cfbfastR-data",
};
const stripClock = (c) => String(c).replace(/^0(\d:)/, "$1");

// Exact 2026 details for the curated Real Moments, pulled from play-by-play by scripts/build_data.py.
REAL_MOMENTS.forEach((m) => {
  const f = typeof MOMENT_FACTS !== "undefined" && MOMENT_FACTS[m.id];
  if (!f) return;
  m.fact = f;
  if (m.league === "nfl") {
    Object.assign(m.situation, { clock: stripClock(f.clock), clockApprox: false, timeouts: { ...f.timeouts } });
    if (m.situation.down == null && f.down) Object.assign(m.situation, { down: f.down, distance: f.distance });
  }
  if (!m.sources.includes(DATA_SOURCE[m.league])) m.sources.push(DATA_SOURCE[m.league]);
});

// Auto-generated 2026 decisions, graded by the win-probability model.
function autoToScenario(m) {
  const best = m.options.reduce((a, b) => (b.wp > a.wp ? b : a));
  const realOpt = m.options.find((o) => o.real);
  const team = m.league === "nfl" ? (NFL_DATA.teams[m.situation.teams.us] || {}).name || m.situation.teams.us : m.prompt.replace(/^You're (.*?)\..*$/, "$1");
  return {
    id: m.id, league: m.league, category: m.category, title: m.title, game: m.game, prompt: m.prompt,
    situation: { ...m.situation, clock: stripClock(m.situation.clock) },
    options: m.options.map((o) => ({
      text: o.text, grade: o.grade, real: o.real,
      feedback: `Model win probability: ${pct(o.wp)}${o === best ? ", the best of the options." : ` (${signed((o.wp - best.wp) * 100, 1)} pts vs. ${best.text.toLowerCase()}).`}`,
    })),
    real: { coach: `the ${team} sideline`, call: realOpt.text, outcome: m.realResult, quote: `Win probability before the snap: ${pct(m.wpBefore)}.` },
    lesson: `${m.convNote} The model, fit to real play-by-play, favors: ${best.text.toLowerCase()}.`,
    sources: [DATA_SOURCE[m.league]],
    auto: true,
  };
}

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $(view).classList.remove("hidden");
  window.scrollTo(0, 0);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 8-bit audio (Web Audio; browsers only allow it after a click) ----------
let audioCtx = null;
let noiseBuffer = null;
function ctx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function tone(freq, start, dur, type = "square", vol = 0.06, slideTo = null) {
  try {
    const ac = ctx();
    const t = ac.currentTime + start;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch {}
}

// Filtered white noise: crowd roar, groan, and the snare in the music.
function noise(start, dur, { freq = 1000, q = 0.7, vol = 0.08, attack = 0.01 } = {}) {
  try {
    const ac = ctx();
    if (!noiseBuffer) {
      noiseBuffer = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = ac.currentTime + start;
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = ac.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(ac.destination);
    src.start(t);
    src.stop(t + dur + 0.02);
  } catch {}
}

const sfx = (fn) => () => { if (state.soundOn) fn(); };
const SFX = {
  click: sfx(() => tone(660, 0, 0.05)),
  hover: sfx(() => tone(880, 0, 0.025, "square", 0.02)),
  best: sfx(() => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.14));
    tone(1047, 0.34, 0.35, "square", 0.05);
    noise(0.05, 1.6, { freq: 900, q: 0.4, vol: 0.12, attack: 0.25 }); // crowd roar
  }),
  ok: sfx(() => {
    [523, 659].forEach((f, i) => tone(f, i * 0.1, 0.14));
    noise(0.05, 0.9, { freq: 800, q: 0.5, vol: 0.05, attack: 0.2 }); // polite applause
  }),
  bad: sfx(() => {
    tone(196, 0, 0.18, "sawtooth", 0.06);
    tone(147, 0.16, 0.4, "sawtooth", 0.06, 110);
    noise(0.1, 1.2, { freq: 300, q: 1.2, vol: 0.09, attack: 0.3 }); // crowd groan
  }),
  tick: sfx(() => tone(1200, 0, 0.03, "square", 0.03)),
  static: sfx(() => { noise(0, 0.35, { freq: 3000, q: 0.3, vol: 0.06, attack: 0.005 }); tone(440, 0.05, 0.12, "square", 0.02, 220); }),
  whistle: sfx(() => {
    tone(2600, 0, 0.12, "sine", 0.05);
    tone(2400, 0.15, 0.32, "sine", 0.05);
  }),
  snap: sfx(() => tone(2700, 0, 0.18, "sine", 0.035)), // short ref whistle each situation
  start: sfx(() => [392, 523, 659, 784, 659, 784].forEach((f, i) => tone(f, i * 0.07, 0.1))),
  fanfare: sfx(() => {
    [392, 392, 392, 523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, i === 6 ? 0.6 : 0.1));
    noise(0.2, 2.2, { freq: 900, q: 0.4, vol: 0.12, attack: 0.4 });
  }),
  gameOver: sfx(() => [392, 330, 262, 196].forEach((f, i) => tone(f, i * 0.2, 0.25, "triangle", 0.07))),
};

// Chiptune loop: bass + arpeggio + hi-hat/snare, scheduled slightly ahead of time.
const MUSIC = {
  bpm: 132,
  bass: [110, 0, 110, 0, 131, 0, 131, 0, 98, 0, 98, 0, 147, 0, 131, 0],
  lead: [440, 523, 659, 523, 523, 659, 784, 659, 392, 494, 587, 494, 587, 698, 880, 698],
  step: 0, next: 0, timer: null,
};
function startMusic() {
  if (!state.musicOn || MUSIC.timer) return;
  try { ctx(); } catch { return; }
  MUSIC.next = audioCtx.currentTime + 0.05;
  MUSIC.timer = setInterval(() => {
    const stepLen = 60 / MUSIC.bpm / 2;
    while (MUSIC.next < audioCtx.currentTime + 0.15) {
      const i = MUSIC.step % 16;
      const at = MUSIC.next - audioCtx.currentTime;
      if (MUSIC.bass[i]) tone(MUSIC.bass[i], at, stepLen * 1.6, "triangle", 0.05);
      if (MUSIC.step % 64 >= 32 || i % 2 === 0) tone(MUSIC.lead[i], at, stepLen * 0.8, "square", 0.012);
      noise(at, 0.03, { freq: 7000, q: 1, vol: 0.012, attack: 0.002 });
      if (i === 4 || i === 12) noise(at, 0.12, { freq: 1800, q: 0.8, vol: 0.03, attack: 0.002 });
      MUSIC.next += stepLen;
      MUSIC.step++;
    }
  }, 50);
}
function stopMusic() {
  clearInterval(MUSIC.timer);
  MUSIC.timer = null;
}

function renderSoundToggle() {
  const b = $("sound-toggle");
  b.textContent = state.soundOn ? "SFX: ON" : "SFX: OFF";
  b.setAttribute("aria-pressed", String(state.soundOn));
  const m = $("music-toggle");
  m.textContent = state.musicOn ? "MUSIC: ON" : "MUSIC: OFF";
  m.setAttribute("aria-pressed", String(state.musicOn));
}

// ---------- Home ----------
function setLeague(league) {
  state.league = league;
  savePref("headset-league", league);
  document.body.dataset.league = league;
  document.querySelectorAll("[data-league]").forEach((b) => {
    b.classList.toggle("active", b.dataset.league === league);
    b.setAttribute("aria-selected", String(b.dataset.league === league));
  });
  document.querySelectorAll("[data-only]").forEach((el) => el.classList.toggle("hidden", el.dataset.only !== league));
}

function renderHome() {
  stopClock();
  setLeague(state.league);
  $("clock-toggle").checked = state.clockOn;
  const best = loadBest();
  $("best-score").textContent = best ? `HI-SCORE (${LEAGUE_NAME[state.league]}): ${best.toLocaleString()}` : "";
  renderDaily();
  $("real-blurb").textContent = `${realPool().length} hand-picked ${LEAGUE_NAME[state.league]} calls from the 2026 season, plus a bank of ${AUTO_MOMENTS.filter((m) => m.league === state.league).length} high-stakes 4th downs pulled from 2026 play-by-play. Make your decision, then see what the coach did, how it played out, and what the win-probability model says.`;
  const list = $("category-list");
  list.innerHTML = "";
  const pool = leaguePool();
  Object.entries(CATEGORIES).forEach(([key, label]) => {
    const count = pool.filter((s) => s.category === key).length;
    if (!count) return;
    const b = document.createElement("button");
    b.textContent = `${label} (${count})`;
    b.onclick = () => startGame(pool.filter((s) => s.category === key));
    list.appendChild(b);
  });
  show("home");
}

function startGame(pool, mode = "random") {
  SFX.start();
  startMusic();
  Object.assign(state, {
    mode,
    queue: mode === "real" ? [...pool] : shuffle(pool).slice(0, GAME_LENGTH),
    index: 0, score: 0, streak: 0, bestStreak: 0, results: [], timeoutsUsed: 0,
  });
  renderScenario();
  show("play");
}

// ---------- HUD + real clocks ----------
function renderHud() {
  $("hud-score").textContent = state.score.toLocaleString();
  const streak = $("hud-streak");
  streak.textContent = state.streak >= STREAK_FOR_BONUS ? `${state.streak} x2` : String(state.streak);
  streak.classList.toggle("hot", state.streak >= STREAK_FOR_BONUS);
  $("hud-clock-wrap").classList.toggle("hidden", !state.clockOn);
  $("clock-tools").classList.toggle("hidden", !state.clockOn);
  $("pips").innerHTML = state.queue.map((_, i) => {
    const r = state.results[i];
    const cls = r ? (r.picked ? r.picked.grade : "bad") : i === state.index ? "current" : "";
    return `<span class="${cls}"></span>`;
  }).join("");
}

const parseGameClock = (str) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fmtGameClock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

// One tick per second: huddle (if a timeout is on), then the play clock and the game clock.
function runClock() {
  stopClock();
  if (!state.clockOn) return;
  state.timer = setInterval(tick, 1000);
}
function tick() {
  if (state.huddle > 0) {
    state.huddle--;
    if (state.huddle === 0) {
      state.timeLeft = PLAY_CLOCK_SHORT;
      SFX.snap();
    }
    renderClock();
    return;
  }
  state.timeLeft--;
  if (state.timeLeft === HEADSET_CUTOFF) SFX.static();
  if (state.timeLeft <= 5 && state.timeLeft > 0) SFX.tick();
  if (tickGameClock()) return;
  renderClock();
  if (state.timeLeft <= 0) {
    stopClock();
    choose(state.queue[state.index], null);
  }
}

// Returns true if the game clock just hit 0:00 and ended the decision.
function tickGameClock() {
  const live = state.live;
  if (!live || !live.clockRunning || state.gameSecs == null) return false;
  const before = state.gameSecs;
  state.gameSecs = Math.max(0, before - 1);
  if ((live.quarter === 2 || live.quarter === 4) && before > 120 && state.gameSecs <= 120) {
    state.gameSecs = 120;
    live.clockRunning = false;
    state.timeLeft = PLAY_CLOCK_SHORT;
    flashNote("Two-minute warning");
    SFX.whistle();
  }
  live.clock = fmtGameClock(state.gameSecs);
  renderScoreboard(live);
  if (state.gameSecs === 0) {
    stopClock();
    choose(state.queue[state.index], null, null, "expired");
    return true;
  }
  return false;
}

function stopClock() {
  clearInterval(state.timer);
  state.timer = null;
}

function renderClock() {
  const el = $("hud-clock");
  const label = $("hud-clock-label");
  const led = $("headset-led");
  if (state.huddle > 0) {
    label.textContent = "Timeout";
    el.textContent = String(state.huddle).padStart(2, "0");
    el.classList.remove("danger");
    led.className = "led on";
    led.textContent = "Headset on";
  } else {
    label.textContent = "Play clock";
    el.textContent = String(Math.max(0, state.timeLeft)).padStart(2, "0");
    el.classList.toggle("danger", state.timeLeft <= 10);
    const on = state.timeLeft > HEADSET_CUTOFF;
    led.className = `led ${on ? "on" : "off"}`;
    led.textContent = on ? `Headset on · cuts out at :${HEADSET_CUTOFF}` : "Headset off";
  }
  renderTimeoutButton();
  lockCalls(isLocked());
}

// With the headset off you can't get a call to the field: only a timeout or a QB audible.
const isLocked = () => state.clockOn && !state.answered && state.huddle === 0 && state.timeLeft <= HEADSET_CUTOFF;
function lockCalls(locked) {
  document.querySelectorAll("#options .option").forEach((b) => {
    if (!state.answered) b.disabled = locked;
    b.classList.toggle("locked", locked);
  });
  $("audible-btn").classList.toggle("hidden", !locked);
}
function qbAudible() {
  if (!isLocked()) return;
  const btns = [...document.querySelectorAll("#options .option")];
  const btn = btns[Math.floor(Math.random() * btns.length)];
  choose(state.queue[state.index], btn._opt, btn, "audible");
}

function renderTimeoutButton() {
  const btn = $("timeout-btn");
  const left = state.live ? state.live.timeouts.us : null;
  // Back-to-back timeouts aren't allowed, so one per decision.
  const can = !state.answered && !state.usedTimeout && left != null && left > 0 && !state.live.coinToss;
  btn.disabled = !can;
  btn.textContent = left == null ? "Timeouts not reported" : `Call timeout (${left} left)`;
}

function callTimeout() {
  if ($("timeout-btn").disabled) return;
  state.live.timeouts.us--;
  state.live.clockRunning = false;
  state.timeoutsUsed++;
  state.usedTimeout = true;
  state.huddle = HUDDLE_SECS;
  SFX.whistle();
  flashNote("Timeout");
  renderScoreboard(state.live);
  renderClock();
}

function flashNote(text) {
  const n = $("clock-note");
  n.textContent = text;
  n.classList.remove("hidden");
  clearTimeout(flashNote.t);
  flashNote.t = setTimeout(() => n.classList.add("hidden"), 1800);
}

// ---------- Scoreboard + field ----------
function ordinal(n) { return ["", "1st", "2nd", "3rd", "4th"][n] || ""; }
function spotText(yardLine) {
  if (yardLine === 50) return "50";
  return yardLine < 50 ? `OWN ${yardLine}` : `OPP ${100 - yardLine}`;
}
const teamLabel = (sit, who) => (sit.teams ? sit.teams[who] : who === "us" ? "YOU" : "OPP");

function renderScoreboard(sit, target = $("scoreboard")) {
  const team = (who) => {
    const n = sit.timeouts[who];
    const tos = n == null
      ? `<span class="unknown">TO: ?</span>`
      : [0, 1, 2].map((i) => `<span class="${i < n ? "on" : ""}"></span>`).join("");
    return `<div class="team ${who}">
      <div class="name">${teamLabel(sit, who)}${sit.teams && who === "us" && !sit.neutral ? " (you)" : ""}</div>
      <div class="pts">${sit.score[who]}</div>
      <div class="tos" title="${n == null ? "timeouts not reported" : `${n} timeouts`}">${tos}</div>
      <div class="ball">${sit.possession === who ? "● ball" : ""}</div>
    </div>`;
  };
  let dd, spot = "";
  if (sit.coinToss) dd = "Coin toss";
  else if (sit.pat) dd = "Try (PAT / 2-pt)";
  else if (sit.down == null) dd = "Down not reported";
  else dd = `${ordinal(sit.down)} & ${sit.goalToGo || sit.yardLine + sit.distance >= 100 ? "Goal" : sit.distance}`;
  if (!sit.coinToss && !sit.pat) spot = `${teamLabel(sit, sit.possession)} ball, ${spotText(sit.yardLine)}`;
  const qtr = sit.quarter <= 4 ? `Q${sit.quarter}` : "OT";
  const clock = sit.clock == null ? "—" : `${sit.clockApprox ? "≈" : ""}${sit.clock}`;
  const clockState = sit.clockRunning === true ? "clock running" : sit.clockRunning === false ? "clock stopped" : "";
  target.innerHTML = `
    ${team("us")}
    <div class="center">
      <div class="qtr">${qtr}</div>
      <div class="clock ${sit.clockRunning ? "" : "stopped"}">${clock}</div>
      <div class="qtr">${clockState}</div>
      <div class="dd">${dd}</div>
      <div class="spot">${spot}</div>
    </div>
    ${team("them")}`;
}

// The field is a zoomed camera on the line of scrimmage, like a broadcast angle.
// Yards run from -10 (back of the offense's end zone) to 110; offense drives left → right.
const view = { start: 0, span: 32 };
const fieldPct = (yl) => ((yl - view.start) / view.span) * 100;
function setView(los) {
  view.span = window.innerWidth < 640 ? 22 : 32;
  const behind = view.span * 0.4; // show more of the field ahead of the ball
  view.start = Math.min(110 - view.span, Math.max(-10, los - behind));
}

// Formations as [yards from the line of scrimmage, % from the top of the field, position].
const OFFENSE = [
  [-1, 32, "LT"], [-1, 41, "LG"], [-1, 50, "C"], [-1, 59, "RG"], [-1, 68, "RT"], [-1, 77, "TE"],
  [-1, 9, "WR"], [-1, 91, "WR"], [-2, 20, "WR"], [-5, 50, "QB"], [-5.5, 62, "RB"],
];
const DEFENSE = [
  [1, 36, "DE"], [1, 45.5, "DT"], [1, 54.5, "DT"], [1, 64, "DE"], [5, 30, "LB"], [5, 50, "LB"], [5, 70, "LB"],
  [6, 10, "CB"], [6, 90, "CB"], [12, 36, "S"], [12, 64, "S"],
];

function renderField(sit, target = $("field")) {
  const field = target;
  if (sit.coinToss) {
    field.className = "field toss";
    field.innerHTML = `<div class="coin" aria-hidden="true"></div><div class="field-caption">Coin toss</div>`;
    return;
  }
  field.className = "field";
  const los = sit.yardLine;
  setView(los);
  const offColor = sit.possession === "us" ? "var(--us)" : "var(--them)";
  const defColor = sit.possession === "us" ? "var(--them)" : "var(--us)";
  const lo = Math.ceil(view.start), hi = Math.floor(view.start + view.span);
  const parts = [];

  // Turf stripes every 5 yards, yard lines, hash marks and numbers.
  for (let y = Math.floor(view.start / 5) * 5; y < view.start + view.span; y += 5) {
    if (y < 0 || y >= 100) continue;
    const a = Math.max(fieldPct(y), 0), b = Math.min(fieldPct(y + 5), 100);
    parts.push(`<div class="stripe ${(y / 5) % 2 ? "alt" : ""}" style="left:${a}%;width:${b - a}%"></div>`);
  }
  for (let y = lo; y <= hi; y++) {
    if (y < 0 || y > 100) continue;
    if (y % 5 === 0) parts.push(`<div class="yard-line ${y === 0 || y === 100 ? "goal" : ""}" style="left:${fieldPct(y)}%"></div>`);
    else parts.push(`<div class="hash" style="left:${fieldPct(y)}%"></div>`);
    if (y % 10 === 0 && y > 0 && y < 100) {
      const n = y <= 50 ? y : 100 - y;
      parts.push(`<span class="yard-num top" style="left:${fieldPct(y)}%">${n}</span><span class="yard-num" style="left:${fieldPct(y)}%">${n}</span>`);
    }
  }
  // End zones, when the camera can see them.
  const endzone = (from, to, color, label, side, ink) => {
    const a = Math.max(fieldPct(from), 0), b = Math.min(fieldPct(to), 100);
    if (b <= 0 || a >= 100) return "";
    return `<div class="endzone ${side}" style="left:${a}%;width:${b - a}%;background:${color};color:${ink}"><span>${label}</span></div>`;
  };
  const inkFor = (who) => (who === "us" ? "var(--us-ink, #000)" : "var(--them-ink, #000)");
  parts.push(endzone(-10, 0, offColor, teamLabel(sit, sit.possession), "left", inkFor(sit.possession)));
  parts.push(endzone(100, 110, defColor, teamLabel(sit, sit.possession === "us" ? "them" : "us"), "right", inkFor(sit.possession === "us" ? "them" : "us")));
  if (view.start + view.span >= 109) parts.push(`<div class="goalpost" style="left:${fieldPct(110) - 1}%"></div>`);

  parts.push(`<div class="marker los" style="left:${fieldPct(los)}%"></div>`);
  if (!sit.pat && !sit.goalToGo && sit.distance != null && los + sit.distance < 100) {
    parts.push(`<div class="marker ltg" style="left:${fieldPct(los + sit.distance)}%"><span class="chain">${sit.distance}</span></div>`);
  }
  const offInk = sit.possession === "us" ? "var(--us-ink, #000)" : "var(--them-ink, #000)";
  const defInk = sit.possession === "us" ? "var(--them-ink, #000)" : "var(--us-ink, #000)";
  const place = (list, color, side) => list.map(([dx, top, pos], i) => {
    const y = Math.min(109, Math.max(-9, los + dx));
    return `<span class="player ${side}" data-i="${i}" style="left:${fieldPct(y)}%;top:${top}%;--team:${color};--ink:${side === "off" ? offInk : defInk}"><i>${pos}</i></span>`;
  }).join("");
  parts.push(place(OFFENSE, offColor, "off"), place(DEFENSE, defColor, "def"));
  parts.push(`<div class="football" id="football" style="left:${fieldPct(los)}%"></div>`);
  parts.push(`<div class="penalty-flag hidden" id="flag"></div>`);
  parts.push(`<div class="field-caption">${sit.possession === "us" ? "You're on offense →" : "You're on defense · they drive →"}</div>`);
  field.innerHTML = parts.join("");
}

function animateField(sc, grade) {
  const field = $("field");
  if (sc.situation.coinToss) {
    field.classList.add("flip");
    return;
  }
  if (grade === "best" || grade === "ok") {
    const ball = $("football");
    const gain = grade === "best" ? 10 : 4;
    const pct = Math.min(97, fieldPct(Math.min(105, sc.situation.yardLine + gain)));
    ball.style.left = `${pct}%`;
    ball.classList.add("run");
    field.querySelectorAll(".player.off").forEach((p) => {
      p.style.left = `${Math.min(97, parseFloat(p.style.left) + (pct - fieldPct(sc.situation.yardLine)) * 0.6)}%`;
    });
  } else {
    const flag = $("flag");
    flag.style.left = `${fieldPct(sc.situation.yardLine)}%`;
    flag.classList.remove("hidden");
    if (!reduceMotion) field.classList.add("shake");
  }
}

// Re-frame the camera when the window is resized.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!$("play").classList.contains("hidden") && state.live && !state.answered) renderField(state.live);
  }, 150);
});

// ---------- Scenario flow ----------
function renderScenario() {
  const sc = state.queue[state.index];
  state.answered = false;
  state.huddle = 0;
  state.usedTimeout = false;
  state.live = JSON.parse(JSON.stringify(sc.situation));
  state.gameSecs = state.live.clockRunning ? parseGameClock(state.live.clock) : null;
  // The two-minute warning (clock stopped at 2:00) resets the play clock to 25.
  state.timeLeft = !state.live.clockRunning && state.live.clock === "2:00" ? PLAY_CLOCK_SHORT : PLAY_CLOCK_SECS;
  $("progress-text").textContent = state.mode === "daily" ? `Daily call · ${todayKey()} · ${sc.game}` : state.mode === "real"
    ? `Real Moment ${state.index + 1} of ${state.queue.length} · ${sc.game}`
    : `Situation ${state.index + 1} of ${state.queue.length}`;
  renderHud();
  renderClock();
  renderScoreboard(state.live);
  renderField(sc.situation);
  $("sc-category").textContent = CATEGORIES[sc.category];
  $("sc-title").textContent = sc.title;
  $("sc-prompt").textContent = sc.prompt;
  ["lesson", "real-card", "next-btn", "banner"].forEach((id) => $(id).classList.add("hidden"));

  const opts = $("options");
  opts.innerHTML = "";
  shuffle(sc.options).forEach((opt, i) => {
    const b = document.createElement("button");
    b.className = "option";
    b.innerHTML = `<span class="key">${i + 1}</span><span class="opt-text">${opt.text}</span>`;
    b.onclick = () => choose(sc, opt, b);
    b.onmouseenter = () => { if (!state.answered) SFX.hover(); };
    b._opt = opt;
    opts.appendChild(b);
  });
  SFX.snap();
  runClock();
}

function choose(sc, picked, pickedBtn, reason) {
  if (state.answered) return;
  state.answered = true;
  stopClock();
  renderTimeoutButton();
  const grade = picked ? picked.grade : "bad";
  $("audible-btn").classList.add("hidden");

  let gained = 0;
  if (grade === "best") state.streak++; else state.streak = 0;
  if (grade !== "bad") {
    const beforeCutoff = state.huddle > 0 || reason === "audible" ? 0 : Math.max(0, state.timeLeft - HEADSET_CUTOFF);
    const speed = state.clockOn ? Math.round((beforeCutoff / (PLAY_CLOCK_SECS - HEADSET_CUTOFF)) * 50) : 0;
    const mult = state.streak >= STREAK_FOR_BONUS ? 2 : 1;
    gained = (POINTS[grade] + Math.min(50, speed)) * mult;
  }
  state.bestStreak = Math.max(state.bestStreak, state.streak);
  state.score += gained;
  state.results.push({ sc, picked, gained, reason });

  document.querySelectorAll(".option").forEach((b) => {
    const opt = b._opt;
    b.disabled = true;
    b.classList.add(opt.grade);
    if (b === pickedBtn) b.classList.add("picked");
    const realTag = opt.real ? `<span class="real-tag">Real call</span>` : "";
    b.innerHTML = `<span class="grade ${opt.grade}">${GRADE_LABEL[opt.grade]}</span>${realTag}<span class="opt-text">${opt.text}</span><span class="fb">${opt.feedback}</span>`;
  });

  const bannerText = reason === "expired" ? "TIME EXPIRED" : picked ? BANNER[grade] : BANNER.timeout;
  showBanner(bannerText, grade, gained);
  if (reason === "audible") flashNote("No call got in. Your QB audibled on his own.");
  (picked ? SFX[grade] : SFX.whistle)();
  animateField(sc, grade);
  renderHud();

  if (sc.real) renderRealCard(sc, picked);
  if (state.mode === "daily") { recordDaily(picked ? picked.grade : "bad"); renderDaily(); }
  const lesson = $("lesson");
  lesson.innerHTML = `<b>Coaching point:</b> ${sc.lesson}`;
  lesson.classList.remove("hidden");
  const next = $("next-btn");
  next.textContent = state.index + 1 < state.queue.length ? "Next situation →" : "Final score →";
  next.classList.remove("hidden");
}

function showBanner(text, grade, gained) {
  const banner = $("banner");
  banner.className = `banner ${grade}`;
  banner.innerHTML = `<div class="banner-text">${text}</div>${gained ? `<div class="banner-pts">+${gained}</div>` : ""}`;
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => banner.classList.add("hidden"), 1300);
}

function numbersBlock(sc) {
  const f = sc.fact;
  if (!f) return "";
  const parts = [];
  if (f.wp != null && sc.league === "nfl") parts.push(`Win probability before the snap: ${pct(f.wp)}`);
  if (f.epa != null && sc.league === "nfl") parts.push(`real play: EPA ${signed(f.epa)}, win probability ${signed(f.wpa * 100, 1)} pts`);
  const label = { go: "Go", punt: "Punt", fg: "Field goal" };
  const st = sc.situation;
  let model = "";
  if (st.down === 4) {
    const [m, sec] = String(st.clock).split(":").map(Number);
    const secs = m * 60 + sec + (4 - st.quarter) * 900;
    const { values, conv } = fourthDownValues({ diff: st.score.us - st.score.them, secs, dist: st.distance, yl100: 100 - st.yardLine,
      posTO: st.timeouts.us ?? 2, defTO: st.timeouts.them ?? 2 }, sc.league);
    model = `<p><b>Model:</b> ${Object.entries(values).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${label[k]} ${pct(v)}`).join(" · ")} win probability. 4th & ${st.distance} converts ${Math.round(conv * 100)}% in real ${sc.league === "nfl" ? "NFL" : "college"} play-by-play.</p>`;
  }
  return `<p><b>By the numbers:</b> ${parts.join("; ") || "from 2026 play-by-play"}.</p>${model}`;
}

// ---------- Daily call ----------
// One real 2026 decision per day, the same for everyone on that date.
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function dailyMoment() {
  const pool = autoPool();
  if (!pool.length) return null;
  let h = 0;
  for (const c of todayKey() + state.league) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}
const dailyKey = () => `headset-daily-${state.league}`;
function loadDaily() { try { return JSON.parse(loadPref(dailyKey()) || "null") || { streak: 0, best: 0, last: null, lastResult: null }; } catch { return { streak: 0, best: 0, last: null }; } }
function renderDaily() {
  const m = dailyMoment();
  const d = loadDaily();
  $("daily-title").textContent = `Daily call · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  $("daily-blurb").textContent = m ? `${m.title}. ${m.game}. One real 2026 decision a day, the same for everyone. Match the model's best call to keep your streak.` : "No decisions available.";
  const played = d.last === todayKey();
  $("start-daily").textContent = played ? "▶ Replay today's call" : "▶ Make today's call";
  $("daily-streak").textContent = `STREAK: ${d.streak} · BEST: ${d.best}${played ? ` · today: ${d.lastResult === "best" ? "✓" : "✗"}` : ""}`;
}
function recordDaily(grade) {
  const d = loadDaily();
  if (d.last === todayKey()) return; // replays don't change the streak
  const y = new Date(Date.now() - 86400000);
  const yKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  const won = grade === "best";
  d.streak = won ? (d.last === yKey && d.lastResult === "best" ? d.streak + 1 : 1) : 0;
  d.best = Math.max(d.best, d.streak);
  d.last = todayKey();
  d.lastResult = won ? "best" : "miss";
  savePref(dailyKey(), JSON.stringify(d));
}

function renderRealCard(sc, picked) {
  const realOpt = sc.options.find((o) => o.real);
  const matched = picked === realOpt;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
  const card = $("real-card");
  card.innerHTML = `
    <div class="real-head">What really happened</div>
    <div class="real-verdict ${matched ? "same" : "diff"}">${matched
      ? `You made the same call as ${sc.real.coach}.`
      : `You went a different way than ${sc.real.coach}.`}</div>
    <p><b>The call:</b> ${sc.real.call}</p>
    <p><b>Result:</b> ${sc.real.outcome}</p>
    <p class="quote">${sc.real.quote}</p>
    ${numbersBlock(sc)}
    <p class="fine">Sources: ${sc.sources.map((u) => `<a href="${u}" target="_blank" rel="noopener">${host(u)}</a>`).join(" · ")}</p>`;
  card.classList.remove("hidden");
}

function nextScenario() {
  SFX.click();
  state.index++;
  if (state.index < state.queue.length) {
    renderScenario();
    window.scrollTo(0, 0);
  } else {
    renderResults();
  }
}

// ---------- Results ----------
function rating(pct) {
  if (pct >= 90) return ["A", "Hall of Fame Head Coach"];
  if (pct >= 75) return ["B", "Playoff Coach"];
  if (pct >= 55) return ["C", "Coordinator Material"];
  if (pct >= 35) return ["D", "Hot Seat"];
  return ["F", "Fired on Black Monday"];
}

function renderResults() {
  stopClock();
  const accuracy = state.results.reduce((sum, r) => sum + (r.picked ? POINTS[r.picked.grade] : 0), 0);
  const pct = Math.round((accuracy / (state.queue.length * POINTS.best)) * 100);
  const [letter, title] = rating(pct);
  const isHigh = state.mode === "random" && state.score > loadBest();
  if (state.mode === "random") saveBest(state.score);
  $("grade-letter").textContent = letter;
  $("grade-letter").className = `grade-box g-${letter}`;
  const stars = pct >= 90 ? 3 : pct >= 65 ? 2 : pct >= 40 ? 1 : 0;
  $("stars").innerHTML = [0, 1, 2].map((i) => `<span class="${i < stars ? "on" : ""}">★</span>`).join("");
  $("rating").textContent = title;
  const bests = state.results.filter((r) => r.picked && r.picked.grade === "best").length;
  $("stats").innerHTML = [
    ["Score", state.score.toLocaleString() + (isHigh ? " · NEW HI!" : "")],
    ["Accuracy", `${pct}%`],
    ["Best calls", `${bests}/${state.queue.length}`],
    ["Top streak", String(state.bestStreak)],
    ...(state.clockOn ? [["Timeouts used", String(state.timeoutsUsed)]] : []),
  ].map(([k, v]) => `<div class="stat"><span class="stat-label">${k}</span><span class="stat-value">${v}</span></div>`).join("");

  const realResults = state.results.filter((r) => r.sc.real);
  const same = realResults.filter((r) => r.picked && r.picked.real).length;
  $("real-summary").textContent = realResults.length
    ? `You matched the real coach on ${same} of ${realResults.length} calls.`
    : "";
  const marks = { best: "✅", ok: "🟡", bad: "❌" };
  $("review").innerHTML = state.results.map(({ sc, picked, reason }) => {
    const best = sc.options.find((o) => o.grade === "best");
    let extra = picked && picked.grade === "best" ? "" : `<div class="fine">Best call: ${best.text}</div>`;
    if (sc.real) extra += `<div class="fine">${sc.real.coach}'s call: ${sc.options.find((o) => o.real).text}</div>`;
    const choice = picked ? (reason === "audible" ? `QB audible: ${picked.text}` : picked.text) : reason === "expired" ? "Nothing: the game clock ran out" : "Delay of game (play clock ran out)";
    return `<div class="review-item"><span class="mark">${marks[picked ? picked.grade : "bad"]}</span><b>${sc.title}</b> — you chose: ${choice}${extra}</div>`;
  }).join("");
  stopMusic();
  (pct >= 75 ? SFX.fanfare : pct >= 55 ? SFX.best : SFX.gameOver)();
  show("results");
}

// ---------- Cheat sheet: real numbers from play-by-play ----------
function renderNumbers() {
  const L = leagueData();
  const k = L.kick;
  const nfl = state.league === "nfl";
  const conv = [1, 2, 3, 4, 5, 6, 8, 10].filter((d) => k.conv4[d] != null)
    .map((d) => `<tr><td>4th & ${d}</td><td>${Math.round(k.conv4[d] * 100)}%</td></tr>`).join("");
  const fg = [30, 40, 45, 50, 55, 60].map((d) => `<tr><td>${d} yards</td><td>${Math.round(fgProb(d) * 100)}%</td></tr>`).join("");
  const epRow = (yl) => expectedPoints(1, 10, yl).toFixed(1);
  const sacks = L.sackRate;
  $("numbers-card").innerHTML = `
    <h2>By the numbers · ${nfl ? "NFL 2023–25" : "College 2024–25"}</h2>
    <p class="fine">Straight from ${nfl ? "nflverse" : "cfbfastR"} play-by-play (${L.meta.plays.toLocaleString()} plays).</p>
    <div class="numbers-grid">
      <table class="chart"><thead><tr><th>4th-down tries</th><th>Converted</th></tr></thead><tbody>${conv}</tbody></table>
      <table class="chart"><thead><tr><th>Field goal</th><th>Made</th></tr></thead><tbody>${fg}</tbody></table>
      <table class="chart"><thead><tr><th>1st & 10 at…</th><th>Expected points</th></tr></thead><tbody>
        <tr><td>Own 10</td><td>${epRow(90)}</td></tr><tr><td>Own 25</td><td>${epRow(75)}</td></tr><tr><td>Midfield</td><td>${epRow(50)}</td></tr>
        <tr><td>Opp 30</td><td>${epRow(30)}</td></tr><tr><td>Opp 10</td><td>${epRow(10)}</td></tr></tbody></table>
      <table class="chart"><thead><tr><th>Other</th><th></th></tr></thead><tbody>
        <tr><td>Extra point</td><td>${Math.round(k.xp * 100)}%</td></tr>
        ${k.two ? `<tr><td>Two-point try</td><td>${Math.round(k.two * 100)}%</td></tr>` : ""}
        <tr><td>Sack rate per dropback</td><td>${(sacks.all * 100).toFixed(1)}%</td></tr>
        ${sacks.blitz ? `<tr><td>…vs. a blitz (5+ rushers)</td><td>${(sacks.blitz * 100).toFixed(1)}%</td></tr>` : ""}
        <tr><td>Average net punt</td><td>${Math.round(avgPuntNet())} yards</td></tr></tbody></table>
    </div>`;
}

// ---------- Clock Lab ----------
function parseClock(str) {
  const m = String(str).trim().match(/^(\d{1,2}):(\d{2})$|^(\d+)$/);
  if (!m) return null;
  return m[3] !== undefined ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

function renderLab() {
  const seconds = parseClock($("lab-clock").value);
  const out = $("lab-result");
  if (seconds === null || seconds <= 0 || seconds > 900) {
    out.innerHTML = `<p>Enter a clock like <b>1:55</b>.</p>`;
    return;
  }
  const r = simulateKneels({
    seconds,
    down: Number($("lab-down").value),
    oppTimeouts: Number($("lab-to").value),
    clockRunning: $("lab-running").checked,
    warningPending: $("lab-warning").checked,
  });
  out.innerHTML = `
    <div class="verdict ${r.win ? "win" : "lose"}">${r.win ? "✅ Yes — kneel it out." : `❌ No — they get ${fmtClock(r.remaining)}.`}</div>
    <ol>${r.log.map((l) => `<li>${l}</li>`).join("")}</ol>`;
}

// ---------- Wiring ----------
document.querySelectorAll("[data-nav]").forEach((b) => {
  b.addEventListener("click", () => {
    SFX.click();
    stopClock();
    const v = b.dataset.nav;
    if (v === "home") renderHome();
    else if (v === "lab") { renderLab(); show("lab"); }
    else if (v === "sheet") { renderNumbers(); show("sheet"); }
    else show(v);
  });
});
$("start-all").onclick = () => startGame(leaguePool());
$("start-real").onclick = () => startGame(realPool(), "real");
$("start-auto").onclick = () => startGame(shuffle(autoPool()).slice(0, GAME_LENGTH), "real");
$("start-daily").onclick = () => { const m = dailyMoment(); if (m) startGame([m], "daily"); };
$("next-btn").onclick = nextScenario;
$("timeout-btn").onclick = callTimeout;
$("audible-btn").onclick = qbAudible;
$("play-again").onclick = () => { startMusic(); renderHome(); };
$("music-toggle").onclick = () => {
  state.musicOn = !state.musicOn;
  savePref("headset-music", state.musicOn ? "on" : "off");
  renderSoundToggle();
  if (state.musicOn) startMusic(); else stopMusic();
};
$("sound-toggle").onclick = () => {
  state.soundOn = !state.soundOn;
  savePref("headset-sound", state.soundOn ? "on" : "off");
  renderSoundToggle();
  SFX.click();
};
$("clock-toggle").onchange = (e) => {
  state.clockOn = e.target.checked;
  savePref("headset-clock", state.clockOn ? "on" : "off");
};
document.querySelectorAll("[data-league]").forEach((b) => {
  b.addEventListener("click", () => { SFX.click(); state.league = b.dataset.league; renderHome(); });
});
["lab-clock", "lab-down", "lab-to", "lab-running", "lab-warning"].forEach((id) => {
  $(id).addEventListener("input", renderLab);
  $(id).addEventListener("change", renderLab);
});

document.addEventListener("keydown", (e) => {
  if ($("play").classList.contains("hidden") || e.target.matches("input, select, textarea")) return;
  if (!state.answered && (e.key === "t" || e.key === "T")) {
    callTimeout();
  } else if (!state.answered && /^[1-4]$/.test(e.key)) {
    const btn = document.querySelectorAll(".option")[Number(e.key) - 1];
    if (btn) btn.click();
  } else if (state.answered && e.key === "Enter") {
    e.preventDefault();
    nextScenario();
  }
});

// Pause the play clock while the tab is hidden, so switching tabs never costs a delay of game.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopClock(); stopMusic(); }
  else {
    if (!$("results").classList.contains("hidden")) return;
    if (audioCtx) startMusic();
    if (!$("play").classList.contains("hidden") && !state.answered) runClock();
  }
});

// Title music starts on the first click or key press (browsers block audio before that).
const firstInteraction = () => {
  window.removeEventListener("pointerdown", firstInteraction);
  window.removeEventListener("keydown", firstInteraction);
  startMusic();
};
window.addEventListener("pointerdown", firstInteraction);
window.addEventListener("keydown", firstInteraction);

renderSoundToggle();
renderHome();
