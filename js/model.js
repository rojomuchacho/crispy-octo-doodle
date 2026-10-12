// Expected points, win probability and decision values, built from real play-by-play
// (see scripts/build_data.py). Mirrors the Python Model class used to grade 2026 moments.

const leagueData = (league = state.league) => (league === "cfb" ? CFB_DATA : NFL_DATA);

function distBucket(d) {
  const edges = [1, 2, 3, 5, 7, 10, 15];
  for (let i = 0; i < edges.length; i++) if (d <= edges[i]) return i;
  return 7;
}

// Expected points for the offense: down 1-4, yards to go, yards to the opponent's goal (1-99).
function expectedPoints(down, dist, yl100, league) {
  const t = leagueData(league).ep;
  const d = Math.min(4, Math.max(1, down || 1)) - 1;
  const y = Math.floor((Math.min(99, Math.max(1, yl100)) - 1) / 5);
  return t[d][distBucket(dist || 10)][y];
}

// Win probability for the team with the ball (regulation only). A smooth model fit to
// nflverse/cfbfastR win probability, blended in the last 15 minutes toward a table of real
// win probability by exact score margin, so cliffs like "up 7 vs up 6" are respected.
function winProb(st, league) {
  const { diff, secs } = st;
  if (secs <= 1) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  const yl = st.yl100 ?? 75;
  if ((secs <= 8 && yl >= 60) || (secs <= 20 && yl >= 50)) return diff > 0 ? 0.97 : diff < 0 ? 0.03 : 0.52;
  const smooth = winProbSmooth(st, league);
  const w = secs <= 300 ? 1 : secs >= 900 ? 0 : (900 - secs) / 600;
  if (w === 0) return smooth;
  const tab = winProbTable(st, league);
  return tab == null ? smooth : w * tab + (1 - w) * smooth;
}

// Field position on 1st & 10 worth the same expected points as this down and distance.
function effectiveYl(down, dist, yl100, league) {
  if (down === 1 && dist >= 10) return yl100;
  const target = expectedPoints(down, dist, yl100, league);
  const row = leagueData(league).ep[0][distBucket(10)];
  let best = 0;
  row.forEach((v, i) => { if (Math.abs(v - target) < Math.abs(row[best] - target)) best = i; });
  return best * 5 + 3;
}

function winProbTable({ diff, secs, down = 1, dist = 10, yl100 = 75, posTO = 3, defTO = 3 }, league) {
  const D = leagueData(league);
  const di = Math.round(Math.max(-D.diffMax, Math.min(D.diffMax, diff))) + D.diffMax;
  let ti = D.timeEdges.findIndex((e) => secs <= e);
  if (ti < 0) ti = D.timeEdges.length - 1;
  const fi = Math.floor((Math.min(99, Math.max(1, effectiveYl(down, dist, yl100, league))) - 1) / 10);
  const cell = D.wpTable[di][ti][fi];
  if (cell == null) return null;
  const c = Math.max(1e-4, Math.min(1 - 1e-4, cell));
  const t = secs / 3600;
  const z = Math.log(c / (1 - c)) + D.wp[5] * (posTO - defTO) * Math.pow(1 - t, 4);
  return 1 / (1 + Math.exp(-z));
}

function winProbSmooth({ diff, secs, down = 1, dist = 10, yl100 = 75, posTO = 3, defTO = 3 }, league) {
  const b = leagueData(league).wp;
  const ep = expectedPoints(down, dist, yl100, league);
  const t = secs / 3600;
  const s = Math.sqrt(secs / 60 + 1);
  const adj = diff + ep;
  const x = [1, diff, adj / s, ep, t, (posTO - defTO) * Math.pow(1 - t, 4), 0, adj / (s * s), Math.sign(adj) * Math.pow(1 - t, 6)];
  const z = x.reduce((sum, v, i) => sum + v * b[i], 0);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

// Our win probability when the other team gets 1st & 10 at their yl100.
const wpAfterChange = (diff, secs, oppYl100, ourTO, theirTO, league) =>
  1 - winProb({ diff: -diff, secs, down: 1, dist: 10, yl100: oppYl100, posTO: theirTO, defTO: ourTO }, league);

const fgProb = (dist, league) => { const [a, b] = leagueData(league).kick.fg; return 1 / (1 + Math.exp(-(a + b * dist))); };
function conv4(dist, league) {
  const c = leagueData(league).kick.conv4;
  const keys = Object.keys(c).map(Number);
  const k = keys.reduce((best, x) => (Math.abs(x - Math.min(dist, 15)) < Math.abs(best - Math.min(dist, 15)) ? x : best), keys[0]);
  return c[k];
}
const avgPuntNet = (league) => { const n = leagueData(league).kick.puntNet; return n.reduce((a, b) => a + b, 0) / n.length; };

// Win probability of going for it, punting and kicking on 4th down.
function fourthDownValues({ diff, secs, dist, yl100, posTO, defTO }, league) {
  const s2 = Math.max(1, secs - 6);
  const out = {};
  const p = conv4(dist, league);
  const tdWin = wpAfterChange(diff + 7, s2, 75, posTO, defTO, league);
  let win = tdWin;
  if (dist < yl100) {
    // A conversion can also go all the way: use the real TD rate on 4th-down plays from here.
    const td = leagueData(league).kick.td4[Math.floor((Math.min(99, Math.max(1, yl100)) - 1) / 5)] || 0;
    const ptd = Math.min(p, td);
    const first = winProb({ diff, secs: s2, down: 1, dist: 10, yl100: yl100 - dist, posTO, defTO }, league);
    win = p > 0 ? (ptd * tdWin + (p - ptd) * first) / p : first;
  }
  const lose = wpAfterChange(diff, s2, 100 - yl100, posTO, defTO, league);
  out.go = p * win + (1 - p) * lose;
  if (yl100 >= 30) {
    const land = yl100 - avgPuntNet(league);
    out.punt = wpAfterChange(diff, Math.max(1, secs - 8), land <= 0 ? 80 : 100 - land, posTO, defTO, league);
  }
  if (yl100 + 17 <= 62) {
    const pf = fgProb(yl100 + 17, league);
    const missSpot = yl100 + 7;
    out.fg = pf * wpAfterChange(diff + 3, s2, 75, posTO, defTO, league)
      + (1 - pf) * wpAfterChange(diff, s2, missSpot <= 20 ? 80 : 100 - missSpot, posTO, defTO, league);
  }
  return { values: out, conv: p };
}

function tryValues({ diffAfterTD, secs, posTO, defTO }, league) {
  const k = leagueData(league).kick;
  const two = k.two || 0.47, xp = k.xp || 0.96;
  const after = (d) => wpAfterChange(d, secs, 75, posTO, defTO, league);
  return { pat: xp * after(diffAfterTD + 1) + (1 - xp) * after(diffAfterTD), two: two * after(diffAfterTD + 2) + (1 - two) * after(diffAfterTD) };
}

