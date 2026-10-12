const POINTS = { best: 10, ok: 5, bad: 0 };
const GRADE_LABEL = { best: "BEST", ok: "OK", bad: "MISS" };
const GAME_LENGTH = 10;
const STORAGE_KEY = "headset-best";

const $ = (id) => document.getElementById(id);
const state = { queue: [], index: 0, score: 0, results: [] };

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

function loadBest() {
  try { return Number(localStorage.getItem(STORAGE_KEY)) || 0; } catch { return 0; }
}
function saveBest(pct) {
  try { if (pct > loadBest()) localStorage.setItem(STORAGE_KEY, String(pct)); } catch {}
}

// ---------- Home ----------
function renderHome() {
  const best = loadBest();
  $("best-score").textContent = best ? `Your best: ${best}%` : "";
  const list = $("category-list");
  list.innerHTML = "";
  Object.entries(CATEGORIES).forEach(([key, label]) => {
    const count = SCENARIOS.filter((s) => s.category === key).length;
    const b = document.createElement("button");
    b.textContent = `${label} (${count})`;
    b.onclick = () => startGame(SCENARIOS.filter((s) => s.category === key));
    list.appendChild(b);
  });
  show("home");
}

function startGame(pool) {
  state.queue = shuffle(pool).slice(0, GAME_LENGTH);
  state.index = 0;
  state.score = 0;
  state.results = [];
  renderScenario();
  show("play");
}

// ---------- Scenario ----------
function ordinal(n) { return ["", "1st", "2nd", "3rd", "4th"][n] || ""; }

function spotText(yardLine) {
  if (yardLine === 50) return "50";
  return yardLine < 50 ? `OWN ${yardLine}` : `OPP ${100 - yardLine}`;
}

function renderScoreboard(sit) {
  const team = (who) => {
    const label = who === "us" ? "YOU" : "OPP";
    const tos = [0, 1, 2].map((i) => `<span class="${i < sit.timeouts[who] ? "on" : ""}"></span>`).join("");
    return `<div class="team ${who}">
      <div class="name">${label}</div>
      <div class="pts">${sit.score[who]}</div>
      <div class="tos" title="${sit.timeouts[who]} timeouts">${tos}</div>
      <div class="ball">${sit.possession === who ? "● ball" : ""}</div>
    </div>`;
  };
  let dd;
  if (sit.pat) dd = "Try (PAT / 2-pt)";
  else dd = `${ordinal(sit.down)} & ${sit.goalToGo || sit.yardLine + sit.distance >= 100 ? "Goal" : sit.distance}`;
  const offense = sit.possession === "us" ? "Your" : "Their";
  const qtr = sit.quarter <= 4 ? `Q${sit.quarter}` : "OT";
  $("scoreboard").innerHTML = `
    ${team("us")}
    <div class="center">
      <div class="qtr">${qtr}</div>
      <div class="clock ${sit.clockRunning ? "" : "stopped"}">${sit.clock}</div>
      <div class="qtr">${sit.clockRunning ? "clock running" : "clock stopped"}</div>
      <div class="dd">${dd}</div>
      <div class="spot">${sit.pat ? "" : `${offense} ball, ${spotText(sit.yardLine)}`}</div>
    </div>
    ${team("them")}`;
}

function renderField(sit) {
  // 120 units: 10 for each end zone, offense always drives left → right.
  const pct = (yl) => ((10 + yl) / 120) * 100;
  const offColor = sit.possession === "us" ? "var(--us)" : "var(--them)";
  const defColor = sit.possession === "us" ? "var(--them)" : "var(--us)";
  const ltg = !sit.pat && !sit.goalToGo && sit.yardLine + sit.distance < 100
    ? `<div class="marker ltg" style="left:${pct(sit.yardLine + sit.distance)}%"></div>` : "";
  $("field").innerHTML = `
    <div class="endzone left" style="background:${offColor}">${sit.possession === "us" ? "YOU" : "OPP"}</div>
    <div class="endzone right" style="background:${defColor}">${sit.possession === "us" ? "OPP" : "YOU"}</div>
    <div class="marker los" style="left:${pct(sit.yardLine)}%"></div>
    ${ltg}
    <div class="football" style="left:${pct(sit.yardLine)}%"></div>
    <div class="direction">${sit.possession === "us" ? "you're driving →" : "they're driving →"}</div>`;
}

function renderScenario() {
  const sc = state.queue[state.index];
  $("progress-text").textContent = `Situation ${state.index + 1} of ${state.queue.length}`;
  $("score-text").textContent = `Score: ${state.score}`;
  renderScoreboard(sc.situation);
  renderField(sc.situation);
  $("sc-category").textContent = CATEGORIES[sc.category];
  $("sc-title").textContent = sc.title;
  $("sc-prompt").textContent = sc.prompt;
  $("lesson").classList.add("hidden");
  $("next-btn").classList.add("hidden");

  const opts = $("options");
  opts.innerHTML = "";
  shuffle(sc.options).forEach((opt) => {
    const b = document.createElement("button");
    b.className = "option";
    b.textContent = opt.text;
    b.onclick = () => choose(sc, opt, b);
    b._opt = opt;
    opts.appendChild(b);
  });
}

function choose(sc, picked, pickedBtn) {
  state.score += POINTS[picked.grade];
  state.results.push({ sc, picked });
  $("score-text").textContent = `Score: ${state.score}`;

  document.querySelectorAll(".option").forEach((b) => {
    const opt = b._opt;
    b.disabled = true;
    b.classList.add(opt.grade);
    if (b === pickedBtn) b.classList.add("picked");
    b.innerHTML = `<span class="grade ${opt.grade}">${GRADE_LABEL[opt.grade]}</span>${opt.text}<span class="fb">${opt.feedback}</span>`;
  });

  const lesson = $("lesson");
  lesson.innerHTML = `<b>Coaching point:</b> ${sc.lesson}`;
  lesson.classList.remove("hidden");
  const next = $("next-btn");
  next.textContent = state.index + 1 < state.queue.length ? "Next situation →" : "See results →";
  next.classList.remove("hidden");
}

function nextScenario() {
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
  if (pct >= 90) return "Hall of Fame Head Coach 🏆";
  if (pct >= 75) return "Playoff Coach";
  if (pct >= 55) return "Coordinator Material";
  if (pct >= 35) return "Hot Seat 🔥";
  return "Fired at Black Monday";
}

function renderResults() {
  const max = state.queue.length * POINTS.best;
  const pct = Math.round((state.score / max) * 100);
  saveBest(pct);
  $("rating").textContent = rating(pct);
  $("final-score").textContent = `${state.score} / ${max} points (${pct}%)`;
  const marks = { best: "✅", ok: "🟡", bad: "❌" };
  $("review").innerHTML = state.results.map(({ sc, picked }) => {
    const best = sc.options.find((o) => o.grade === "best");
    const extra = picked.grade === "best" ? "" : `<div class="fine">Best call: ${best.text}</div>`;
    return `<div class="review-item"><span class="mark">${marks[picked.grade]}</span><b>${sc.title}</b> — you chose: ${picked.text}${extra}</div>`;
  }).join("");
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
    const v = b.dataset.nav;
    if (v === "home") renderHome();
    else if (v === "lab") { renderLab(); show("lab"); }
    else show(v);
  });
});
$("start-all").onclick = () => startGame(SCENARIOS);
$("next-btn").onclick = nextScenario;
$("play-again").onclick = renderHome;
["lab-clock", "lab-down", "lab-to", "lab-running", "lab-warning"].forEach((id) => {
  $(id).addEventListener("input", renderLab);
  $(id).addEventListener("change", renderLab);
});

renderHome();
