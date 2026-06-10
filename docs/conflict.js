// Conflict prediction: pairwise closest point of approach (CPA) in the
// observer's local ENU frame from current position + velocity, plus a
// turn-aware short-term predicted path ("cone") for the selected aircraft.
// Pure math, no DOM — unit-testable under `node --test`
// (see ./test/conflict.test.mjs).
//
// Alert criterion (drawn on the dome + ⚠ in the status line): predicted
// separation < 1 km horizontally AND < 300 m vertically within 90 s.

const DEG = Math.PI / 180;
export const CPA_HORIZON_S = 90;
export const CPA_H_LIMIT_M = 1000;
export const CPA_V_LIMIT_M = 300;
const FRESH_S = 30; // ignore tracks without a fix in the last 30 s

// Observer-frame ENU (metres) of a projected point {az, el, range}.
export function enuOf(p) {
  const az = p.az * DEG, el = p.el * DEG;
  const ch = Math.cos(el) * p.range;
  return { e: ch * Math.sin(az), n: ch * Math.cos(az), u: p.range * Math.sin(el) };
}

// ENU velocity (m/s) from a feed velocity snapshot {gs_ms, trackDeg, vrate_ms}.
export function velEnu(vel) {
  const b = vel.trackDeg * DEG;
  return { e: vel.gs_ms * Math.sin(b), n: vel.gs_ms * Math.cos(b), u: vel.vrate_ms || 0 };
}

// Closest point of approach of two constant-velocity states within
// [0, horizonS]: returns {t, dh, dv} (time s, horizontal m, vertical m).
export function cpa(pa, va, pb, vb, horizonS = CPA_HORIZON_S) {
  const px = pb.e - pa.e, py = pb.n - pa.n, pz = pb.u - pa.u;
  const vx = vb.e - va.e, vy = vb.n - va.n, vz = vb.u - va.u;
  const v2 = vx * vx + vy * vy + vz * vz;
  let t = v2 < 1e-9 ? 0 : -(px * vx + py * vy + pz * vz) / v2;
  t = Math.max(0, Math.min(horizonS, t));
  return {
    t,
    dh: Math.hypot(px + vx * t, py + vy * t),
    dv: Math.abs(pz + vz * t),
  };
}

// All conflicting pairs among live tracks. Each track needs a projected
// last point (az/el/range) and a velocity snapshot. Returns
// [{a, b, t, dh, dv}] sorted by soonest CPA.
export function detectConflicts(tracks, nowT, horizonS = CPA_HORIZON_S) {
  const states = [];
  for (const tr of tracks) {
    const last = tr.points[tr.points.length - 1];
    if (!last || last.az === undefined || !tr.vel) continue;
    if (nowT - last.t > FRESH_S) continue;
    states.push({ tr, p: enuOf(last), v: velEnu(tr.vel) });
  }
  const out = [];
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const r = cpa(states[i].p, states[i].v, states[j].p, states[j].v, horizonS);
      if (r.dh < CPA_H_LIMIT_M && r.dv < CPA_V_LIMIT_M) {
        out.push({ a: states[i].tr, b: states[j].tr, t: r.t, dh: r.dh, dv: r.dv });
      }
    }
  }
  out.sort((x, y) => x.t - y.t);
  return out;
}

// Mean signed heading rate (deg/s) over the recent path: successive step
// bearings (steps > 30 m so noise doesn't dominate) differenced over time.
export function headingRateDegS(points, nowT, windowS = 90) {
  const t0 = nowT - windowS;
  let prev = null, prevBrg = null, sum = 0, n = 0;
  for (const p of points) {
    if (p.t < t0) continue;
    if (prev) {
      const dy = (p.lat - prev.lat) * 111132;
      const dx = (p.lon - prev.lon) * 111320 *
        Math.cos((((prev.lat + p.lat) / 2) * Math.PI) / 180);
      if (Math.hypot(dx, dy) > 30 && p.t > prev.t) {
        const brg = ((Math.atan2(dx, dy) / DEG) + 360) % 360;
        if (prevBrg !== null) {
          const d = ((brg - prevBrg + 540) % 360) - 180; // signed turn
          sum += d / (p.t - prev.t);
          n++;
        }
        prevBrg = brg;
      }
    }
    prev = p;
  }
  return n ? sum / n : 0;
}

// Turn-aware dead reckoning: advance from {lat, lon, alt_m} with velocity
// `vel`, heading drifting at rateDegS. Returns [{lat, lon, alt_m}, ...].
export function predictPath(start, vel, rateDegS, secs = 90, stepS = 5) {
  const out = [];
  let { lat, lon } = start, alt = start.alt_m, hdg = vel.trackDeg;
  for (let t = stepS; t <= secs; t += stepS) {
    hdg += rateDegS * stepS;
    const b = hdg * DEG, d = vel.gs_ms * stepS;
    lat += (d * Math.cos(b)) / 111132;
    lon += (d * Math.sin(b)) / (111320 * Math.cos((lat * Math.PI) / 180));
    alt += (vel.vrate_ms || 0) * stepS;
    out.push({ lat, lon, alt_m: alt });
  }
  return out;
}

// Prediction cone for one track: centre path at the measured heading rate,
// left/right edges at rate ± spread (spread grows with the measured rate so
// straight flight gets a narrow cone, turns a wide one). Null without data.
export function predictCone(tr, nowT, secs = 90) {
  const last = tr.points[tr.points.length - 1];
  if (!last || last.az === undefined || !tr.vel || tr.vel.gs_ms < 20) return null;
  const rate = headingRateDegS(tr.points, nowT);
  const spread = 0.3 + Math.abs(rate) * 0.5; // deg/s
  return {
    center: predictPath(last, tr.vel, rate, secs),
    left: predictPath(last, tr.vel, rate - spread, secs),
    right: predictPath(last, tr.vel, rate + spread, secs),
  };
}
