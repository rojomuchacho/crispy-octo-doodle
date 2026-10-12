// Real-game companion: watch a game, get an alert on every 4th down, make your call before
// the coach does, then see what the coach did and what the win-probability model says.
//
// Two feeds share the same flow:
//   - Live: ESPN's public scoreboard JSON, polled every 15 seconds. Only works where the page
//     can reach site.api.espn.com (a self-hosted copy); the published claude.ai page blocks it.
//   - Replay: real 2026 games from nflverse / cfbfastR play-by-play (js/data/replays.js).
// The ESPN field names below are read defensively: anything missing is skipped, not guessed.

const ESPN = {
  nfl: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  cfb: "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard",
};
const LIVE_POLL_MS = 15000;
const DECIDE_SECS = 25;

const live = {
  mode: null,          // "live" | "replay"
  league: "nfl",
  games: [],           // normalized live games
  focus: null,         // game id being shown
  pollTimer: null,
  replay: null,        // { game, idx, timer, speed }
  prompt: null,        // open 4th-down prompt
  seen: new Set(),     // prompts already raised
  history: [],         // finished decisions
  pendingReveal: [],   // live prompts waiting for the real call
};

// ---------- Normalized game state ----------
// { id, league, home, away, hs, as, q, clock, secs, down, dist, yl100, posHome, hto, ato, wpHome, last, final }
const clockToSecs = (clock) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(clock || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const gameSecsLeft = (q, clock) => {
  const s = clockToSecs(clock);
  if (s == null || q > 4) return s;
  return s + (4 - q) * 900;
};

function stateSit(g) {
  const posHome = g.posHome;
  return {
    quarter: g.q, clock: String(g.clock || "").replace(/^0(\d:)/, "$1"), clockRunning: null,
    score: { us: g.hs ?? 0, them: g.as ?? 0 }, teams: { us: g.home, them: g.away },
    possession: posHome == null ? null : posHome ? "us" : "them", coinToss: posHome == null,
    down: g.down, distance: g.dist, yardLine: g.yl100 == null ? 50 : 100 - g.yl100,
    goalToGo: g.dist != null && g.yl100 != null && g.dist >= g.yl100,
    timeouts: { us: g.hto ?? null, them: g.ato ?? null }, neutral: true,
  };
}

// Win probability for the home team, from the feed if it has one, otherwise the model.
function homeWP(g) {
  if (g.wpHome != null) return g.wpHome;
  if (g.down == null || g.yl100 == null || g.posHome == null) return null;
  const secs = gameSecsLeft(g.q, g.clock);
  if (secs == null || g.q > 4) return null;
  const diff = (g.hs - g.as) * (g.posHome ? 1 : -1);
  const p = winProb({ diff, secs, down: g.down, dist: g.dist, yl100: g.yl100,
    posTO: g.posHome ? g.hto ?? 2 : g.ato ?? 2, defTO: g.posHome ? g.ato ?? 2 : g.hto ?? 2 }, g.league);
  return g.posHome ? p : 1 - p;
}

// ---------- ESPN live feed ----------
async function pollLive() {
  const url = ESPN[live.league];
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    live.games = (json.events || []).map((e) => normalizeEspn(e, live.league)).filter(Boolean);
    setLiveStatus(live.games.length
      ? `${live.games.filter((g) => g.state === "in").length} game(s) in progress · updated ${new Date().toLocaleTimeString()}`
      : "No games on the ESPN scoreboard right now.");
    if (!live.focus || !live.games.some((g) => g.id === live.focus)) {
      const g = live.games.find((x) => x.state === "in") || live.games[0];
      live.focus = g ? g.id : null;
      if (g) renderFocus(g);
    }
    renderGameList();
    live.games.forEach((g) => { if (g.state === "in") onGameState(g); });
    resolveLiveReveals();
  } catch (err) {
    setLiveStatus("Can't reach ESPN's live scoreboard from this page. Live mode works in a self-hosted copy of the game (see the README). Try a replay instead.", true);
    stopLive();
  }
}

function normalizeEspn(e, league) {
  const c = e.competitions && e.competitions[0];
  if (!c) return null;
  const home = (c.competitors || []).find((t) => t.homeAway === "home");
  const away = (c.competitors || []).find((t) => t.homeAway === "away");
  if (!home || !away) return null;
  const sit = c.situation || {};
  const abbr = (t) => (t.team && (t.team.abbreviation || t.team.shortDisplayName)) || "?";
  const posId = sit.possession;
  const posHome = posId == null ? null : String(posId) === String(home.team && home.team.id);
  // possessionText looks like "KC 38": the yard line on that team's side of the field.
  let yl100 = null;
  const m = /^([A-Z&.]+)\s+(\d{1,2})$/.exec(String(sit.possessionText || "").trim());
  if (m && posHome != null) {
    const offense = posHome ? abbr(home) : abbr(away);
    const n = Number(m[2]);
    yl100 = m[1] === offense ? 100 - n : n;
  } else if (/50$/.test(String(sit.possessionText || ""))) yl100 = 50;
  const status = c.status || e.status || {};
  return {
    id: String(e.id), league, home: abbr(home), away: abbr(away),
    hs: Number(home.score) || 0, as: Number(away.score) || 0,
    q: status.period || null, clock: status.displayClock || null, state: status.type && status.type.state,
    down: sit.down > 0 ? sit.down : null, dist: sit.distance ?? null, yl100, posHome,
    hto: sit.homeTimeouts ?? null, ato: sit.awayTimeouts ?? null,
    last: sit.lastPlay ? { text: sit.lastPlay.text || "", type: (sit.lastPlay.type && sit.lastPlay.type.text) || "" } : null,
    shortDetail: status.type && status.type.shortDetail,
  };
}

// The real call shows up as the next "last play" after a 4th-down situation.
function resolveLiveReveals() {
  live.pendingReveal = live.pendingReveal.filter((p) => {
    const g = live.games.find((x) => x.id === p.gameId);
    if (!g || !g.last || g.last.text === p.lastTextAtPrompt) return true;
    const t = `${g.last.type} ${g.last.text}`.toLowerCase();
    const real = /punt/.test(t) ? "punt" : /field goal/.test(t) ? "fg" : /timeout/.test(t) ? null : "go";
    if (!real) return true; // a timeout first: keep waiting for the snap
    finishDecision(p, real, g.last.text);
    return false;
  });
}

// ---------- Replay feed ----------
function startReplay(gameId, fromQ4) {
  stopLive();
  const game = REPLAY_GAMES.find((g) => g.id === gameId);
  if (!game) return;
  live.mode = "replay";
  live.league = game.league;
  live.seen = new Set();
  live.history = [];
  let idx = 0;
  if (fromQ4) idx = Math.max(0, game.plays.findIndex((p) => p[0] >= 4));
  live.replay = { game, idx, timer: null, speed: live.replay ? live.replay.speed : 1, paused: false };
  $("live-title").textContent = `Replay · ${game.title}`;
  setLiveStatus(`Week ${game.week}, 2026 · final: ${game.final}. Every 4th down pauses the game for your call.`);
  $("replay-controls").classList.remove("hidden");
  renderSpeed();
  renderTally();
  show("live");
  startMusic();
  replayStep();
}

function replayRowToGame(game, row) {
  const [q, clock, down, dist, yl100, pos, hs, as, hto, ato, type, desc, wpHome] = row;
  return { id: game.id, league: game.league, home: game.home, away: game.away, hs, as, q, clock, down, dist, yl100,
    posHome: pos === "H", hto, ato, wpHome, type, desc, state: "in" };
}

function replayStep() {
  const r = live.replay;
  if (!r || r.paused || live.prompt) return;
  clearTimeout(r.timer);
  if (r.idx >= r.game.plays.length) {
    setLiveStatus(`Final: ${r.game.final}.`);
    renderTally(true);
    return;
  }
  const row = r.game.plays[r.idx];
  const g = replayRowToGame(r.game, row);
  live.games = [g];
  live.focus = g.id;
  renderFocus(g);
  const raised = onGameState(g, row);
  if (!raised) {
    addLiveLog(`<span class="log-clock">Q${g.q > 4 ? "OT" : g.q} ${g.clock}</span>${g.desc}`);
    r.idx++;
    r.timer = setTimeout(replayStep, 2600 / r.speed);
  }
}

// ---------- Shared 4th-down flow ----------
// Returns true if a prompt was raised (the replay waits for it).
function onGameState(g, replayRow) {
  if (live.mode === "live" && live.focus === g.id) renderFocus(g);
  if (g.down !== 4 || g.yl100 == null || g.posHome == null || g.q > 4) return false;
  if (replayRow && !["run", "pass", "punt", "fg"].includes(g.type)) return false;
  const key = `${g.id}-${g.q}-${g.clock}-${g.yl100}`;
  if (live.seen.has(key) || live.prompt) return false;
  live.seen.add(key);
  const secs = gameSecsLeft(g.q, g.clock);
  if (secs == null) return false;
  const off = g.posHome ? "home" : "away";
  const diff = (g.hs - g.as) * (g.posHome ? 1 : -1);
  const { values, conv } = fourthDownValues({ diff, secs, dist: g.dist, yl100: g.yl100,
    posTO: (g.posHome ? g.hto : g.ato) ?? 2, defTO: (g.posHome ? g.ato : g.hto) ?? 2 }, g.league);
  live.prompt = {
    gameId: g.id, game: g, off, values, conv, picked: null, left: DECIDE_SECS,
    realFromReplay: replayRow ? (g.type === "punt" ? "punt" : g.type === "fg" ? "fg" : "go") : null,
    realText: replayRow ? g.desc : null, lastTextAtPrompt: g.last ? g.last.text : null,
  };
  if (live.focus !== g.id) { live.focus = g.id; renderFocus(g); }
  renderPrompt();
  SFX.whistle();
  flashLiveAlert(`4th & ${g.dist} · ${g.posHome ? g.home : g.away} ball`);
  clearInterval(live.promptTimer);
  live.promptTimer = setInterval(() => {
    if (!live.prompt || live.prompt.picked) return clearInterval(live.promptTimer);
    live.prompt.left--;
    if (live.prompt.left <= 5 && live.prompt.left > 0) SFX.tick();
    if (live.prompt.left <= 0) { clearInterval(live.promptTimer); pickLive(null); return; }
    $("live-countdown").textContent = live.prompt.left;
  }, 1000);
  return true;
}

function pickLive(choice) {
  const p = live.prompt;
  if (!p || p.picked) return;
  p.picked = choice || "none";
  clearInterval(live.promptTimer);
  SFX.click();
  if (p.realFromReplay) finishDecision(p, p.realFromReplay, p.realText);
  else {
    live.pendingReveal.push(p);
    renderPrompt("Locked in. Waiting for the real snap…");
  }
}

function finishDecision(p, real, realText) {
  const ranked = Object.entries(p.values).sort((a, b) => b[1] - a[1]);
  const best = ranked[0][0];
  const g = p.game;
  const team = g.posHome ? g.home : g.away;
  const rec = { team, where: `Q${g.q} ${g.clock}, 4th & ${g.dist} at ${g.yl100 >= 50 ? "own " + (100 - g.yl100) : "opp " + g.yl100}`,
    pick: p.picked, real, best, values: p.values, conv: p.conv, realText };
  live.history.unshift(rec);
  const label = { go: "Go for it", punt: "Punt", fg: "Field goal", none: "No call" };
  const vs = (k) => (p.values[k] != null ? pct(p.values[k]) : "—");
  const youMatchedCoach = rec.pick === real, youMatchedModel = rec.pick === best, coachMatchedModel = real === best;
  (youMatchedModel ? SFX.best : SFX.ok)();
  $("live-prompt").innerHTML = `
    <div class="real-head">4th down result · ${team}</div>
    <p><b>You:</b> ${label[rec.pick]} ${rec.pick !== "none" ? `(${vs(rec.pick)})` : ""} · <b>Coach:</b> ${label[real]} (${vs(real)}) · <b>Model:</b> ${label[best]} (${vs(best)})</p>
    <p class="real-verdict ${youMatchedModel ? "same" : "diff"}">${youMatchedModel ? "You made the model's call." : `The model preferred ${label[best].toLowerCase()}.`}
      ${youMatchedCoach ? " Same call as the coach." : " Different call from the coach."}${coachMatchedModel ? "" : " The coach went against the model."}</p>
    ${realText ? `<p class="fine">What happened: ${realText}</p>` : ""}
    <p class="fine">4th & ${g.dist} converts ${Math.round(p.conv * 100)}% in real play-by-play. Win probability shown for the team with the ball.</p>
    ${live.mode === "replay" ? `<button class="primary" id="live-continue">▶ Continue</button>` : ""}`;
  const cont = $("live-continue");
  if (cont) cont.onclick = () => { live.prompt = null; $("live-prompt").classList.add("hidden"); if (live.replay) { live.replay.idx++; replayStep(); } };
  else setTimeout(() => { if (live.prompt === p) { live.prompt = null; $("live-prompt").classList.add("hidden"); } }, 12000);
  renderTally();
}

// ---------- Rendering ----------
function setLiveStatus(text, warn = false) {
  const el = $("live-status");
  el.textContent = text;
  el.classList.toggle("warn", warn);
}
function flashLiveAlert(text) { showBanner("4TH DOWN!", "ok", 0); addLiveLog(`<b class="neg">ALERT</b> ${text}`); }

function renderFocus(g) {
  const sit = stateSit(g);
  renderScoreboard(sit, $("live-scoreboard"));
  if (g.down != null && g.yl100 != null && g.posHome != null) renderField(sit, $("live-field"));
  const wp = homeWP(g);
  $("live-wp-fill").style.width = wp == null ? "50%" : `${(wp * 100).toFixed(1)}%`;
  $("live-wp-num").textContent = wp == null ? "—" : `${g.home} ${Math.round(wp * 100)}%`;
}

function renderPrompt(waiting) {
  const p = live.prompt;
  const el = $("live-prompt");
  el.classList.remove("hidden");
  if (!p) return;
  const g = p.game;
  const team = g.posHome ? g.home : g.away;
  if (waiting) { el.innerHTML = `<div class="real-head">${team}: 4th & ${g.dist}</div><p>${waiting}</p>`; return; }
  const opts = Object.keys(p.values).map((k) =>
    `<button class="call" data-live-pick="${k}"><span>${{ go: "Go for it", punt: "Punt", fg: "Field goal" }[k]}</span><small>${k === "fg" ? `${g.yl100 + 17}-yard try` : k === "punt" ? "Flip the field" : `4th & ${g.dist}`}</small></button>`).join("");
  el.innerHTML = `
    <div class="real-head">Your call · ${team} ball · decide in <span id="live-countdown">${p.left}</span>s</div>
    <h2>4th & ${g.dist} at ${g.yl100 >= 50 ? `own ${100 - g.yl100}` : `opp ${g.yl100}`} · Q${g.q} ${g.clock} · ${g.away} ${g.as}, ${g.home} ${g.hs}</h2>
    <div class="sim-calls">${opts}</div>
    <p class="fine">Keys: <kbd>1</kbd>–<kbd>${Object.keys(p.values).length}</kbd></p>`;
  el.querySelectorAll("[data-live-pick]").forEach((b) => (b.onclick = () => pickLive(b.dataset.livePick)));
}

function renderTally(final = false) {
  const h = live.history;
  const n = h.length;
  const youModel = h.filter((r) => r.pick === r.best).length;
  const coachModel = h.filter((r) => r.real === r.best).length;
  const youCoach = h.filter((r) => r.pick === r.real).length;
  $("live-tally").innerHTML = n
    ? `<div class="stats">
        <div class="stat"><span class="stat-label">4th downs</span><span class="stat-value">${n}</span></div>
        <div class="stat"><span class="stat-label">You matched the model</span><span class="stat-value">${youModel}/${n}</span></div>
        <div class="stat"><span class="stat-label">Coaches matched the model</span><span class="stat-value">${coachModel}/${n}</span></div>
        <div class="stat"><span class="stat-label">You matched the coach</span><span class="stat-value">${youCoach}/${n}</span></div>
      </div>${final ? `<p class="sim-score">${youModel > coachModel ? "You out-coached the coaches." : youModel === coachModel ? "Dead even with the real coaches." : "The real coaches edged you this time."}</p>` : ""}`
    : `<p class="fine">No 4th downs yet. You'll get an alert the moment one comes up.</p>`;
}

function renderGameList() {
  const list = $("live-games");
  if (live.mode !== "live") { list.innerHTML = ""; return; }
  list.innerHTML = live.games.map((g) => `
    <button class="drive-card ${g.id === live.focus ? "active" : ""}" data-live-game="${g.id}">
      <span class="drive-title">${g.away} ${g.as} · ${g.home} ${g.hs}</span>
      <span class="drive-blurb">${g.shortDetail || ""}${g.down ? ` · ${ordinal(g.down)} & ${g.dist}` : ""}</span>
    </button>`).join("");
  list.querySelectorAll("[data-live-game]").forEach((b) => (b.onclick = () => {
    live.focus = b.dataset.liveGame;
    const g = live.games.find((x) => x.id === live.focus);
    if (g) renderFocus(g);
    renderGameList();
  }));
}

function addLiveLog(html) {
  const ol = $("live-log");
  const li = document.createElement("li");
  li.innerHTML = html;
  ol.prepend(li);
  while (ol.children.length > 80) ol.lastChild.remove();
}

function renderSpeed() {
  document.querySelectorAll("[data-speed]").forEach((b) => b.classList.toggle("active", Number(b.dataset.speed) === live.replay.speed));
}

function renderReplayMenu() {
  $("replay-list").innerHTML = REPLAY_GAMES.filter((g) => g.league === state.league).map((g) => `
    <button class="drive-card" data-replay="${g.id}">
      <span class="drive-side">Week ${g.week}, 2026 · ${g.league === "nfl" ? "NFL" : "College"}</span>
      <span class="drive-title">${g.title}</span>
      <span class="drive-blurb">Final: ${g.final}</span>
    </button>`).join("") || `<p class="fine">No replays for this league yet.</p>`;
  $("replay-list").querySelectorAll("[data-replay]").forEach((b) => (b.onclick = () => startReplay(b.dataset.replay, $("replay-q4").checked)));
}

// ---------- Start / stop ----------
function startLive() {
  stopLive();
  live.mode = "live";
  live.league = state.league;
  live.history = [];
  live.seen = new Set();
  $("live-title").textContent = `Live · ${LEAGUE_NAME[state.league]} games`;
  $("replay-controls").classList.add("hidden");
  $("live-prompt").classList.add("hidden");
  setLiveStatus("Connecting to ESPN's live scoreboard…");
  renderTally();
  show("live");
  pollLive();
  live.pollTimer = setInterval(pollLive, LIVE_POLL_MS);
}
function stopLive() {
  clearInterval(live.pollTimer);
  live.pollTimer = null;
  if (live.replay) clearTimeout(live.replay.timer);
  clearInterval(live.promptTimer);
  live.prompt = null;
  if ($("live-prompt")) $("live-prompt").classList.add("hidden");
}

// ---------- Wiring ----------
$("start-live").onclick = startLive;
document.querySelectorAll("[data-speed]").forEach((b) => (b.onclick = () => {
  if (!live.replay) return;
  live.replay.speed = Number(b.dataset.speed);
  renderSpeed();
}));
$("replay-pause").onclick = () => {
  if (!live.replay) return;
  live.replay.paused = !live.replay.paused;
  $("replay-pause").textContent = live.replay.paused ? "▶ Resume" : "❚❚ Pause";
  if (!live.replay.paused) replayStep(); else clearTimeout(live.replay.timer);
};
document.addEventListener("keydown", (e) => {
  if ($("live").classList.contains("hidden") || !live.prompt || live.prompt.picked) return;
  const b = document.querySelectorAll("[data-live-pick]")[Number(e.key) - 1];
  if (b) b.click();
});
document.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", stopLive));
document.querySelectorAll("[data-league]").forEach((b) => b.addEventListener("click", renderReplayMenu));
renderReplayMenu();
