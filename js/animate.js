// 8-bit play animations for the simulator field.
// Every sprite gets keyframes [t, yard, top%, arc] (t from 0 to 1, yard on the field's
// -10..110 scale, arc = peak height in px for the ball's flight into that frame).
// Frames are stepped at ~12 fps for an arcade feel.

const ANIM_FPS = 12;

// Formation slots (see OFFENSE / DEFENSE in app.js).
const OS = { OL: [0, 1, 2, 3, 4], TE: 5, WR1: 6, WR2: 7, SLOT: 8, QB: 9, RB: 10 };
const DS = { DL: [0, 1, 2, 3], LB: [4, 5, 6], CB1: 7, CB2: 8, S: [9, 10] };

function animatePlay(fieldEl, ctx) {
  // ctx: { key, r, los, defCall }
  return new Promise((resolve) => {
    if (reduceMotion) return resolve();
    const off = [...fieldEl.querySelectorAll(".player.off")];
    const def = [...fieldEl.querySelectorAll(".player.def")];
    const ball = fieldEl.querySelector(".football");
    if (!ball || off.length < 11 || def.length < 11) return resolve();

    const { key, r, los, defCall } = ctx;
    const base = (list, i) => [los + list[i][0], list[i][1]];
    const ob = (i) => base(OFFENSE, i);
    const db = (i) => base(DEFENSE, i);
    const tracks = new Map();
    const set = (el, frames) => tracks.set(el, frames);
    const end = los + (r.yards || 0);
    const isPass = ["quickOut", "slant", "deep", "hail"].includes(key);
    const isRun = key === "runIn" || key === "runOut";
    let duration = 1700;

    // --- default offense: line blocks, receivers run decoy routes, everyone else holds
    off.forEach((el, i) => {
      const [y, t] = ob(i);
      if (OS.OL.includes(i)) set(el, [[0, y, t], [0.3, y + (isPass ? -1.5 : 1), t], [1, y + (isPass ? -1.2 : 1.6), t]]);
      else if ([OS.WR1, OS.WR2, OS.SLOT, OS.TE].includes(i)) set(el, [[0, y, t], [1, y + (i === OS.TE ? 3 : 9), t + (t < 50 ? 4 : -4)]]);
      else set(el, [[0, y, t], [1, y, t]]);
    });
    // --- default defense: engage, then pursue the ball's final spot
    const pursuit = (i, tgtY, tgtTop, k = 0.7) => {
      const [y, t] = db(i);
      let mid = [0.3, y + (DS.DL.includes(i) ? -0.6 : isPass ? 2 : -0.5), t];
      if (defCall === "blitz" && DS.LB.includes(i)) mid = [0.35, los - 4, 46 + (i - 5) * 4];
      if (defCall === "prevent" && (i === DS.CB1 || i === DS.CB2 || DS.S.includes(i))) mid = [0.3, y + 7, t];
      return [[0, y, t], mid, [1, y + (tgtY - y) * k, t + (tgtTop - t) * k]];
    };
    def.forEach((el, i) => set(el, pursuit(i, end, 50)));

    const snap = [[0, los, 50], [0.1, los - 5, 50]]; // shotgun snap to the QB
    const qb = off[OS.QB], rb = off[OS.RB];

    if (isRun) {
      const outside = key === "runOut";
      const lane = outside ? 84 : 52;
      const endTop = outside && r.oob ? 103 : lane;
      set(rb, [[0, ...ob(OS.RB)], [0.25, los - 2, outside ? 72 : 54], [0.45, los + 0.5, lane], [1, end, endTop]]);
      set(qb, [[0, ...ob(OS.QB)], [0.2, los - 5.5, 56], [1, los - 6, 50]]);
      set(ball, [...snap, [0.22, los - 5, 56], [0.25, los - 2, outside ? 72 : 54], [0.45, los + 0.5, lane], [1, end, endTop]]);
      def.forEach((el, i) => set(el, pursuit(i, end + 0.8, endTop, DS.DL.includes(i) ? 0.5 : 0.85)));
      if (r.fumble) loose(ball, end, endTop);
    } else if (r.sack) {
      const sackY = los + r.yards;
      set(qb, [[0, ...ob(OS.QB)], [0.3, los - 7, 50], [0.55, sackY, 52], [1, sackY, 54]]);
      set(def[DS.DL[0]], [[0, ...db(DS.DL[0])], [0.55, sackY + 0.4, 50], [1, sackY + 0.2, 52]]);
      set(def[DS.DL[3]], [[0, ...db(DS.DL[3])], [0.6, sackY + 0.6, 56], [1, sackY + 0.4, 55]]);
      set(ball, [...snap, [0.3, los - 7, 50], [0.55, sackY, 52], [1, sackY, 54]]);
      if (r.fumble) loose(ball, sackY, 54);
    } else if (isPass) {
      duration = key === "deep" || key === "hail" ? 2300 : 1800;
      const throwT = key === "deep" || key === "hail" ? 0.4 : 0.38;
      const catchT = key === "deep" || key === "hail" ? 0.8 : 0.66;
      let tgt, route, catchY, catchTop, endTop;
      if (key === "quickOut") {
        tgt = OS.WR1;
        catchY = los + Math.max(3, Math.min(r.yards || 6, 7));
        catchTop = 6;
        endTop = r.oob ? -4 : 5;
        route = [[0, ...ob(tgt)], [0.35, catchY - 1, 9], [catchT, catchY, catchTop]];
      } else if (key === "slant") {
        tgt = OS.SLOT;
        catchY = los + Math.max(4, Math.min(r.yards || 7, 9));
        catchTop = 40;
        endTop = 46;
        route = [[0, ...ob(tgt)], [0.3, los + 2, 23], [catchT, catchY, catchTop]];
      } else {
        tgt = OS.WR2;
        const deepY = key === "hail" ? Math.min(108, los + (100 - los) + 2) : los + (r.yards || 30);
        catchY = deepY;
        catchTop = key === "hail" ? 50 : 80;
        endTop = r.oob ? 103 : 78;
        route = [[0, ...ob(tgt)], [catchT, catchY, catchTop]];
        if (key === "hail") [OS.WR1, OS.SLOT, OS.TE].forEach((i, n) => set(off[i], [[0, ...ob(i)], [catchT, deepY - 1, 40 + n * 10], [1, deepY, 45 + n * 8]]));
      }
      set(qb, [[0, ...ob(OS.QB)], [throwT, los - 7, 50], [1, los - 7, 50]]);
      const peak = key === "deep" || key === "hail" ? 90 : 34;
      if (r.int) {
        const thief = key === "slant" ? def[DS.LB[0]] : key === "quickOut" ? def[DS.CB1] : def[DS.S[1]];
        set(off[tgt], [...route, [1, catchY + 1, catchTop + 3]]);
        set(thief, [[0, ...db(key === "slant" ? DS.LB[0] : key === "quickOut" ? DS.CB1 : DS.S[1])], [catchT, catchY + 0.5, catchTop], [1, catchY - 8, catchTop + 8]]);
        set(ball, [...snap, [throwT, los - 7, 50], [catchT, catchY + 0.5, catchTop, peak], [1, catchY - 8, catchTop + 8]]);
      } else if (r.inc) {
        set(off[tgt], [...route, [1, catchY + 2, catchTop]]);
        const overshoot = key === "deep" ? 6 : 3;
        set(ball, [...snap, [throwT, los - 7, 50], [catchT, catchY + 0.6, catchTop, peak], [Math.min(1, catchT + 0.12), catchY + overshoot, catchTop + 3, 10], [1, catchY + overshoot + 0.5, catchTop + 3]]);
        def.forEach((el, i) => set(el, pursuit(i, catchY + 1, catchTop, 0.6)));
      } else {
        set(off[tgt], [...route, [1, end, endTop]]);
        set(ball, [...snap, [throwT, los - 7, 50], [catchT, catchY, catchTop, peak], [1, end, endTop]]);
        def.forEach((el, i) => set(el, pursuit(i, end + 0.8, endTop, 0.85)));
      }
    } else if (key === "spike") {
      duration = 900;
      set(qb, [[0, los - 1, 50], [0.4, los - 1.5, 50], [1, los - 1.5, 50]]);
      set(ball, [[0, los, 50], [0.3, los - 1.2, 50], [0.6, los - 0.6, 53, 8], [1, los - 0.4, 54]]);
    } else if (key === "kneel") {
      duration = 1100;
      set(qb, [[0, los - 1, 50], [0.4, los - 2, 50], [1, los - 2, 50]]);
      set(ball, [[0, los, 50], [0.3, los - 1.5, 50], [1, los - 2, 50]]);
      setTimeout(() => qb.classList.add("down"), duration * 0.4);
    } else if (key === "fg") {
      duration = 1800;
      const posts = 110;
      const miss = !r.good;
      set(ball, [[0, los, 50], [0.15, los - 7, 50], [0.9, posts, miss ? (Math.random() < 0.5 ? 20 : 80) : 50, 120], [1, posts + 2, miss ? 18 : 50]]);
      set(off[OS.QB], [[0, los - 7, 52], [1, los - 7, 52]]);
      set(off[OS.RB], [[0, los - 9, 50], [0.15, los - 7.5, 50], [1, los - 6.5, 50]]);
    } else if (key === "punt") {
      duration = 2000;
      const land = los + (r.net || 40);
      set(off[OS.RB], [[0, los - 12, 50], [1, los - 11, 50]]);
      set(ball, [[0, los, 50], [0.15, los - 12, 50], [0.9, land, 50, 140], [1, land + 2, 52]]);
      [OS.WR1, OS.WR2].forEach((i) => set(off[i], [[0, ...ob(i)], [1, land - 3, ob(i)[1] < 50 ? 30 : 70]]));
    } else if (key === "letScore") {
      set(rb, [[0, ...ob(OS.RB)], [0.3, los, 52], [1, 102, 50]]);
      set(ball, [...snap, [0.25, los - 2, 54], [0.3, los, 52], [1, 102, 50]]);
      def.forEach((el, i) => { const [y, t] = db(i); set(el, [[0, y, t], [1, y + 1, t + (t < 50 ? -12 : 12)]]); });
    }

    function loose(b, y, t) {
      const f = tracks.get(b);
      tracks.set(b, [...f.map((k) => [k[0] * 0.8, k[1], k[2], k[3]]), [0.9, y + 1.5, t + 6, 18], [1, y + 2, t + 8]]);
    }

    ball.classList.add("flying");
    const start = performance.now();
    const steps = Math.round((duration / 1000) * ANIM_FPS);
    function frame(now) {
      const raw = Math.min(1, (now - start) / duration);
      const t = Math.min(1, Math.floor(raw * steps) / steps);
      tracks.forEach((frames, el) => placeSprite(el, frames, t, el === ball));
      if (raw < 1) requestAnimationFrame(frame);
      else { ball.classList.remove("flying"); resolve(); }
    }
    // Sprites move frame by frame, so turn off their CSS transitions during the play.
    tracks.forEach((_, el) => (el.style.transition = "none"));
    requestAnimationFrame(frame);
  });
}

function placeSprite(el, frames, t, isBall) {
  let a = frames[0], b = frames[frames.length - 1];
  for (let i = 0; i < frames.length - 1; i++) {
    if (t >= frames[i][0] && t <= frames[i + 1][0]) { a = frames[i]; b = frames[i + 1]; break; }
  }
  const span = b[0] - a[0] || 1;
  const u = Math.max(0, Math.min(1, (t - a[0]) / span));
  const y = a[1] + (b[1] - a[1]) * u;
  const top = a[2] + (b[2] - a[2]) * u;
  el.style.left = `${fieldPct(y)}%`;
  el.style.top = `${top}%`;
  if (isBall) {
    const h = b[3] ? Math.sin(Math.PI * u) * b[3] : 0;
    el.style.transform = `translate(-50%, calc(-50% - ${h.toFixed(0)}px)) scale(${(1 + h / 160).toFixed(2)})`;
  }
}
