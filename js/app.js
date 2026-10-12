// Arcade scoring: accuracy points + speed bonus, multiplied while on a streak.
const POINTS = { best: 100, ok: 50, bad: 0 };
const GRADE_LABEL = { best: "BEST", ok: "OK", bad: "MISS" };
const BANNER = { best: "GREAT CALL!", ok: "NOT BAD", bad: "FLAG!", timeout: "DELAY OF GAME" };
const GAME_LENGTH = 10;
const PLAY_CLOCK_SECS = 40;
const STREAK_FOR_BONUS = 3;
const LEAGUE_NAME = { nfl: "NFL", cfb: "College" };

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  league: loadPref("headset-league") || "nfl",
  clockOn: loadPref("headset-clock") !== "off",
  soundOn: loadPref("headset-sound") !== "off",
  mode: "random",
  queue: [], index: 0, score: 0, streak: 0, bestStreak: 0, results: [],
  timer: null, timeLeft: PLAY_CLOCK_SECS, answered: false,
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

// ---------- 8-bit sound (Web Audio; browsers only allow it after a click) ----------
let audioCtx = null;
function tone(freq, start, dur, type = "square", vol = 0.06) {
  if (!state.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime + start;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur);
  } catch {}
}
const SFX = {
  click: () => tone(660, 0, 0.05),
  best: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.12)),
  ok: () => [523, 659].forEach((f, i) => tone(f, i * 0.1, 0.12)),
  bad: () => { tone(196, 0, 0.18, "sawtooth"); tone(147, 0.16, 0.3, "sawtooth"); },
  tick: () => tone(1200, 0, 0.03, "square", 0.03),
  whistle: () => { tone(2200, 0, 0.12, "sine", 0.05); tone(2200, 0.16, 0.3, "sine", 0.05); },
  start: () => [392, 523, 659, 784, 659, 784].forEach((f, i) => tone(f, i * 0.07, 0.1)),
};

function renderSoundToggle() {
  const b = $("sound-toggle");
  b.textContent = state.soundOn ? "SFX: ON" : "SFX: OFF";
  b.setAttribute("aria-pressed", String(state.soundOn));
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
  $("real-blurb").textContent = `${realPool().length} real ${LEAGUE_NAME[state.league]} calls from the 2026 season. Make your decision, then see what the coach actually did and how it played out.`;
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
  Object.assign(state, {
    mode,
    queue: mode === "real" ? [...pool] : shuffle(pool).slice(0, GAME_LENGTH),
    index: 0, score: 0, streak: 0, bestStreak: 0, results: [],
  });
  renderScenario();
  show("play");
}

// ---------- HUD + play clock ----------
function renderHud() {
  $("hud-score").textContent = state.score.toLocaleString();
  const streak = $("hud-streak");
  streak.textContent = state.streak >= STREAK_FOR_BONUS ? `${state.streak} x2` : String(state.streak);
  streak.classList.toggle("hot", state.streak >= STREAK_FOR_BONUS);
  $("hud-clock-wrap").classList.toggle("hidden", !state.clockOn);
  $("pips").innerHTML = state.queue.map((_, i) => {
    const r = state.results[i];
    const cls = r ? (r.picked ? r.picked.grade : "bad") : i === state.index ? "current" : "";
    return `<span class="${cls}"></span>`;
  }).join("");
}

function runClock() {
  stopClock();
  if (!state.clockOn) return;
  state.timer = setInterval(() => {
    state.timeLeft--;
    renderClock();
    if (state.timeLeft <= 5 && state.timeLeft > 0) SFX.tick();
    if (state.timeLeft <= 0) {
      stopClock();
      choose(state.queue[state.index], null);
    }
  }, 1000);
}
function stopClock() {
  clearInterval(state.timer);
  state.timer = null;
}
function renderClock() {
  const el = $("hud-clock");
  el.textContent = String(Math.max(0, state.timeLeft)).padStart(2, "0");
  el.classList.toggle("danger", state.timeLeft <= 10);
}

// ---------- Scoreboard + field ----------
function ordinal(n) { return ["", "1st", "2nd", "3rd", "4th"][n] || ""; }
function spotText(yardLine) {
  if (yardLine === 50) return "50";
  return yardLine < 50 ? `OWN ${yardLine}` : `OPP ${100 - yardLine}`;
}
const teamLabel = (sit, who) => (sit.teams ? sit.teams[who] : who === "us" ? "YOU" : "OPP");

function renderScoreboard(sit) {
  const team = (who) => {
    const n = sit.timeouts[who];
    const tos = n == null
      ? `<span class="unknown">TO: ?</span>`
      : [0, 1, 2].map((i) => `<span class="${i < n ? "on" : ""}"></span>`).join("");
    return `<div class="team ${who}">
      <div class="name">${teamLabel(sit, who)}${sit.teams && who === "us" ? " (you)" : ""}</div>
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
  $("scoreboard").innerHTML = `
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

// Field is 120 units wide (two 10-yard end zones); offense always drives left → right.
const fieldPct = (yl) => ((10 + yl) / 120) * 100;

// Formations as [yards from the line of scrimmage, % from the top of the field].
const OFFENSE = [[-1, 30], [-1, 40], [-1, 50], [-1, 60], [-1, 70], [-1, 80], [-1, 8], [-1, 92], [-5, 50], [-7, 50], [-1.5, 20]];
const DEFENSE = [[1, 32], [1, 44], [1, 56], [1, 68], [4, 38], [4, 50], [4, 62], [7, 12], [7, 88], [12, 40], [12, 60]];

function renderField(sit) {
  const field = $("field");
  if (sit.coinToss) {
    field.className = "field toss";
    field.innerHTML = `<div class="coin" aria-hidden="true"></div><div class="field-caption">Coin toss</div>`;
    return;
  }
  field.className = "field";
  const offColor = sit.possession === "us" ? "var(--us)" : "var(--them)";
  const defColor = sit.possession === "us" ? "var(--them)" : "var(--us)";
  const los = sit.yardLine;
  const ltg = !sit.pat && !sit.goalToGo && sit.distance != null && los + sit.distance < 100
    ? `<div class="marker ltg" style="left:${fieldPct(los + sit.distance)}%"></div>` : "";
  const nums = [10, 20, 30, 40, 50, 60, 70, 80, 90].map((y) =>
    `<span class="yard-num" style="left:${fieldPct(y)}%">${y <= 50 ? y : 100 - y}</span>`).join("");
  const clamp = (y) => Math.min(108, Math.max(-8, y));
  const players = (list, color) => list.map(([dx, top]) =>
    `<span class="player" style="left:${fieldPct(clamp(los + dx))}%;top:${top}%;background:${color}"></span>`).join("");
  field.innerHTML = `
    <div class="endzone left" style="background:${offColor}">${teamLabel(sit, sit.possession)}</div>
    <div class="endzone right" style="background:${defColor}">${teamLabel(sit, sit.possession === "us" ? "them" : "us")}</div>
    ${nums}
    <div class="marker los" style="left:${fieldPct(los)}%"></div>
    ${ltg}
    ${players(OFFENSE, offColor)}
    ${players(DEFENSE, defColor)}
    <div class="football" id="football" style="left:${fieldPct(los)}%"></div>
    <div class="penalty-flag hidden" id="flag"></div>
    <div class="field-caption">${sit.possession === "us" ? "you're driving →" : "they're driving →"}</div>`;
}

function animateField(sc, grade) {
  const field = $("field");
  if (sc.situation.coinToss) {
    field.classList.add("flip");
    return;
  }
  if (grade === "best" || grade === "ok") {
    const ball = $("football");
    const gain = grade === "best" ? 12 : 5;
    ball.style.left = `${fieldPct(Math.min(105, sc.situation.yardLine + gain))}%`;
    ball.classList.add("run");
  } else {
    const flag = $("flag");
    flag.style.left = `${fieldPct(sc.situation.yardLine)}%`;
    flag.classList.remove("hidden");
    if (!reduceMotion) field.classList.add("shake");
  }
}

// ---------- Scenario flow ----------
function renderScenario() {
  const sc = state.queue[state.index];
  state.answered = false;
  state.timeLeft = PLAY_CLOCK_SECS;
  $("progress-text").textContent = state.mode === "real"
    ? `Real Moment ${state.index + 1} of ${state.queue.length} · ${sc.game}`
    : `Situation ${state.index + 1} of ${state.queue.length}`;
  renderHud();
  renderClock();
  renderScoreboard(sc.situation);
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
    b._opt = opt;
    opts.appendChild(b);
  });
  runClock();
}

function choose(sc, picked, pickedBtn) {
  if (state.answered) return;
  state.answered = true;
  stopClock();
  const grade = picked ? picked.grade : "bad";

  let gained = 0;
  if (grade === "best") state.streak++; else state.streak = 0;
  if (grade !== "bad") {
    const speed = state.clockOn ? Math.round((state.timeLeft / PLAY_CLOCK_SECS) * 50) : 0;
    const mult = state.streak >= STREAK_FOR_BONUS ? 2 : 1;
    gained = (POINTS[grade] + speed) * mult;
  }
  state.bestStreak = Math.max(state.bestStreak, state.streak);
  state.score += gained;
  state.results.push({ sc, picked, gained });

  document.querySelectorAll(".option").forEach((b) => {
    const opt = b._opt;
    b.disabled = true;
    b.classList.add(opt.grade);
    if (b === pickedBtn) b.classList.add("picked");
    const realTag = opt.real ? `<span class="real-tag">Real call</span>` : "";
    b.innerHTML = `<span class="grade ${opt.grade}">${GRADE_LABEL[opt.grade]}</span>${realTag}<span class="opt-text">${opt.text}</span><span class="fb">${opt.feedback}</span>`;
  });

  showBanner(picked ? BANNER[grade] : BANNER.timeout, grade, gained);
  (picked ? SFX[grade] : SFX.whistle)();
  animateField(sc, grade);
  renderHud();

  if (sc.real) renderRealCard(sc, picked);
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
  const isHigh = state.mode !== "real" && state.score > loadBest();
  if (state.mode !== "real") saveBest(state.score);
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
  ].map(([k, v]) => `<div class="stat"><span class="stat-label">${k}</span><span class="stat-value">${v}</span></div>`).join("");

  const realResults = state.results.filter((r) => r.sc.real);
  const same = realResults.filter((r) => r.picked && r.picked.real).length;
  $("real-summary").textContent = realResults.length
    ? `You matched the real coach on ${same} of ${realResults.length} calls.`
    : "";
  const marks = { best: "✅", ok: "🟡", bad: "❌" };
  $("review").innerHTML = state.results.map(({ sc, picked }) => {
    const best = sc.options.find((o) => o.grade === "best");
    let extra = picked && picked.grade === "best" ? "" : `<div class="fine">Best call: ${best.text}</div>`;
    if (sc.real) extra += `<div class="fine">${sc.real.coach}'s call: ${sc.options.find((o) => o.real).text}</div>`;
    const choice = picked ? picked.text : "Delay of game (play clock ran out)";
    return `<div class="review-item"><span class="mark">${marks[picked ? picked.grade : "bad"]}</span><b>${sc.title}</b> — you chose: ${choice}${extra}</div>`;
  }).join("");
  (pct >= 55 ? SFX.best : SFX.bad)();
  show("results");
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
    else show(v);
  });
});
$("start-all").onclick = () => startGame(leaguePool());
$("start-real").onclick = () => startGame(realPool(), "real");
$("next-btn").onclick = nextScenario;
$("play-again").onclick = renderHome;
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
  if (!state.answered && /^[1-4]$/.test(e.key)) {
    const btn = document.querySelectorAll(".option")[Number(e.key) - 1];
    if (btn) btn.click();
  } else if (state.answered && e.key === "Enter") {
    e.preventDefault();
    nextScenario();
  }
});

// Pause the play clock while the tab is hidden, so switching tabs never costs a delay of game.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopClock();
  else if (!$("play").classList.contains("hidden") && !state.answered) runClock();
});

renderSoundToggle();
renderHome();
