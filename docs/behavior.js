// Behavior detectors over rolling live tracks — pure functions on the
// canonical track shape ({points: [{t, lat, lon, alt_m}], vel: {gs_ms,
// trackDeg}}). No DOM, no projection imports: unit-testable under
// `node --test` (see ./test/behavior.test.mjs).
//
// Window-based heuristics tuned for the 5 s ADS-B cadence:
//   holding    — racetrack/orbit: long path, tiny net displacement
//   grid       — survey/mapping: parallel legs joined by ~180° reversals
//   goaround   — approach below ~600 m followed by a sustained climb
//   formation  — two aircraft < 1 km apart with matched heading + speed

const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 111320;

// Display badges for the aircraft table / details panel.
export const BADGES = {
  holding: "HOLD", grid: "GRID", goaround: "GO-AROUND", formation: "FORM",
};

// Equirectangular ground distance, metres (mirrors track.rs flat_distance_m).
export function flatDistM(aLat, aLon, bLat, bLon) {
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  const dx = (bLon - aLon) * M_PER_DEG_LON *
    Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

function bearingDeg(a, b) {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lon - a.lon) * M_PER_DEG_LON *
    Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

// Smallest circular difference between two headings, degrees in [0, 180].
export function circDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function recent(points, nowT, windowS) {
  const t0 = nowT - windowS;
  let i = points.length;
  while (i > 0 && points[i - 1].t >= t0) i--;
  return points.slice(i);
}

// Latest point with p.t <= t (or null).
function atTime(points, t) {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].t <= t) return points[i];
  }
  return null;
}

// Holding pattern: over the last ~6 min the aircraft flew a long path that
// went nowhere — path ≥ 4 km with net displacement < 25 % of it.
export function detectHolding(points, nowT) {
  const w = recent(points, nowT, 360);
  if (w.length < 8) return false;
  let path = 0;
  for (let i = 1; i < w.length; i++) {
    path += flatDistM(w[i - 1].lat, w[i - 1].lon, w[i].lat, w[i].lon);
  }
  if (path < 4000) return false;
  const net = flatDistM(w[0].lat, w[0].lon, w[w.length - 1].lat, w[w.length - 1].lon);
  return net / path < 0.25;
}

// Survey grid: ≥ 4 straight legs (≥ 800 m, ≥ 4 steps each) whose
// consecutive bearings reverse by ~180°, over the last ~20 min — the
// "lawnmower" signature of mapping/survey flights.
export function detectSurveyGrid(points, nowT) {
  const w = recent(points, nowT, 1200);
  if (w.length < 24) return false;
  const legs = [];
  let cur = null;
  for (let i = 1; i < w.length; i++) {
    const d = flatDistM(w[i - 1].lat, w[i - 1].lon, w[i].lat, w[i].lon);
    if (d < 15) continue; // stationary / duplicate fix
    const brg = bearingDeg(w[i - 1], w[i]);
    if (cur && circDiff(brg, cur.mean()) < 25) {
      cur.s += Math.sin((brg * Math.PI) / 180);
      cur.c += Math.cos((brg * Math.PI) / 180);
      cur.n += 1;
      cur.len += d;
    } else {
      if (cur && cur.n >= 4 && cur.len >= 800) legs.push(cur.mean());
      cur = {
        s: Math.sin((brg * Math.PI) / 180),
        c: Math.cos((brg * Math.PI) / 180),
        n: 1, len: d,
        mean() { return ((Math.atan2(this.s, this.c) * 180) / Math.PI + 360) % 360; },
      };
    }
  }
  if (cur && cur.n >= 4 && cur.len >= 800) legs.push(cur.mean());
  if (legs.length < 4) return false;
  let reversals = 0;
  for (let i = 1; i < legs.length; i++) {
    if (circDiff(legs[i], legs[i - 1]) > 155) reversals++;
  }
  return reversals >= 3;
}

// Go-around: within the last ~10 min the aircraft descended ≥ 150 m to a
// minimum below 600 m, then climbed ≥ 200 m back out without a track gap.
export function detectGoAround(points, nowT) {
  const w = recent(points, nowT, 600);
  if (w.length < 10) return false;
  let mi = 0;
  for (let i = 0; i < w.length; i++) if (w[i].alt_m < w[mi].alt_m) mi = i;
  if (w[mi].alt_m > 600 || mi === 0 || mi >= w.length - 3) return false;
  let preMax = -Infinity, postMax = -Infinity;
  for (let i = 0; i < mi; i++) preMax = Math.max(preMax, w[i].alt_m);
  for (let i = mi; i < w.length; i++) postMax = Math.max(postMax, w[i].alt_m);
  return preMax - w[mi].alt_m >= 150 && postMax - w[mi].alt_m >= 200;
}

// Formation: distinct moving aircraft (> 30 m/s) < 1 km apart now AND
// ~30 s ago, headings within 15°, speeds within 15 %, altitudes within
// 600 m. Returns pairs of track objects.
export function detectFormationPairs(tracks, nowT) {
  const pairs = [];
  const fresh = tracks.filter((tr) => {
    const last = tr.points[tr.points.length - 1];
    return last && nowT - last.t < 30 && tr.vel && tr.vel.gs_ms > 30;
  });
  for (let i = 0; i < fresh.length; i++) {
    for (let j = i + 1; j < fresh.length; j++) {
      const a = fresh[i], b = fresh[j];
      if (circDiff(a.vel.trackDeg, b.vel.trackDeg) > 15) continue;
      const gsMax = Math.max(a.vel.gs_ms, b.vel.gs_ms);
      if (Math.abs(a.vel.gs_ms - b.vel.gs_ms) / gsMax > 0.15) continue;
      const al = a.points[a.points.length - 1], bl = b.points[b.points.length - 1];
      if (Math.abs(al.alt_m - bl.alt_m) > 600) continue;
      if (flatDistM(al.lat, al.lon, bl.lat, bl.lon) > 1000) continue;
      const a30 = atTime(a.points, nowT - 30), b30 = atTime(b.points, nowT - 30);
      if (a30 && b30 && flatDistM(a30.lat, a30.lon, b30.lat, b30.lon) > 1200) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

// Annotate every track in place: tr.behaviors = ["holding", ...] and
// tr.badges = "HOLD·FORM" (consumed by live-feed.js syncLiveTable and the
// details panel). Holding suppresses grid (both are turn-heavy).
export function detectBehaviors(tracks, nowT) {
  const inFormation = new Set();
  for (const [a, b] of detectFormationPairs(tracks, nowT)) {
    inFormation.add(a);
    inFormation.add(b);
  }
  for (const tr of tracks) {
    const found = [];
    if (detectHolding(tr.points, nowT)) found.push("holding");
    else if (detectSurveyGrid(tr.points, nowT)) found.push("grid");
    if (detectGoAround(tr.points, nowT)) found.push("goaround");
    if (inFormation.has(tr)) found.push("formation");
    tr.behaviors = found;
    tr.badges = found.map((k) => BADGES[k]).join("·");
  }
}
