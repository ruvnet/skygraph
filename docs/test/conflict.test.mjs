// node --test — synthetic-input tests for CPA conflict prediction.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpa, enuOf, velEnu, detectConflicts, headingRateDegS, predictPath,
  predictCone,
} from "../conflict.js";

const NOW = 1_781_200_000;

test("cpa of a head-on pair is at the midpoint time, zero separation", () => {
  // 10 km apart on the E axis, closing at 100 m/s each → meet in 50 s.
  const r = cpa(
    { e: -5000, n: 0, u: 1000 }, { e: 100, n: 0, u: 0 },
    { e: 5000, n: 0, u: 1000 }, { e: -100, n: 0, u: 0 },
  );
  assert.ok(Math.abs(r.t - 50) < 1e-6, `t ${r.t}`);
  assert.ok(r.dh < 1e-6 && r.dv < 1e-6);
});

test("cpa clamps to the horizon for slowly converging pairs", () => {
  const r = cpa(
    { e: -50000, n: 0, u: 0 }, { e: 10, n: 0, u: 0 },
    { e: 50000, n: 0, u: 0 }, { e: -10, n: 0, u: 0 },
  );
  assert.equal(r.t, 90); // never reaches CPA inside 90 s
  assert.ok(r.dh > 90_000);
});

test("detectConflicts flags a converging pair and skips a diverging one", () => {
  const mk = (az, el, range, gs, hdg) => ({
    icao24: `${az}-${hdg}`,
    points: [{ t: NOW - 2, lat: 43.5, lon: -79.7, alt_m: 1500, az, el, range }],
    vel: { gs_ms: gs, trackDeg: hdg, vrate_ms: 0 },
  });
  // One due E at 6 km flying W, one due W at 6 km flying E, same level
  // → meet overhead in ~30 s at 200 m/s each.
  const a = mk(90, 14, 6200, 200, 270);
  const b = mk(270, 14, 6200, 200, 90);
  // High-altitude crosser nowhere near them.
  const c = mk(0, 60, 11000, 200, 0);
  const conflicts = detectConflicts([a, b, c], NOW);
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].dh < 1000 && conflicts[0].dv < 300);
  assert.ok(conflicts[0].t > 10 && conflicts[0].t < 60, `t ${conflicts[0].t}`);
  // Reverse the headings → diverging, no conflict.
  a.vel.trackDeg = 90;
  b.vel.trackDeg = 270;
  assert.equal(detectConflicts([a, b, c], NOW).length, 0);
});

test("headingRateDegS measures a steady turn", () => {
  // 3°/s right turn at ~100 m/s for 60 s.
  const pts = [];
  let lat = 43.5, lon = -79.7, hdg = 0;
  for (let i = 0; i < 13; i++) {
    pts.push({ t: NOW - 60 + i * 5, lat, lon, alt_m: 1000 });
    hdg += 15; // 3°/s × 5 s
    lat += (500 * Math.cos((hdg * Math.PI) / 180)) / 111132;
    lon += (500 * Math.sin((hdg * Math.PI) / 180)) /
      (111320 * Math.cos((lat * Math.PI) / 180));
  }
  const rate = headingRateDegS(pts, NOW);
  assert.ok(Math.abs(rate - 3) < 0.8, `rate ${rate}`);
});

test("predictPath curves with the heading rate; cone brackets the centre", () => {
  const start = { lat: 43.5, lon: -79.7, alt_m: 1000 };
  const vel = { gs_ms: 100, trackDeg: 0, vrate_ms: 0 };
  const straight = predictPath(start, vel, 0, 60, 5);
  const curved = predictPath(start, vel, 3, 60, 5);
  // Straight north: longitude unchanged; curved: drifts east.
  assert.ok(Math.abs(straight[straight.length - 1].lon - start.lon) < 1e-9);
  assert.ok(curved[curved.length - 1].lon > start.lon + 0.01);

  const tr = {
    points: [{ t: NOW - 2, lat: 43.5, lon: -79.7, alt_m: 1000, az: 10, el: 20, range: 5000 }],
    vel,
  };
  const cone = predictCone(tr, NOW, 60);
  assert.ok(cone && cone.center.length && cone.left.length === cone.center.length);
  // Left edge ends west of right edge for a northbound aircraft.
  assert.ok(cone.left[cone.left.length - 1].lon < cone.right[cone.right.length - 1].lon);
});
