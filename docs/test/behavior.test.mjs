// node --test — synthetic-input tests for the pure behavior detectors.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectHolding, detectSurveyGrid, detectGoAround, detectFormationPairs,
  detectBehaviors,
} from "../behavior.js";

const NOW = 1_781_200_000;

// Circular orbit: radius ~2 km around a fix, one lap ~4 min.
function orbitPoints() {
  const pts = [];
  for (let i = 0; i < 60; i++) {
    const a = (i / 48) * 2 * Math.PI; // 1.25 laps
    pts.push({
      t: NOW - 300 + i * 5,
      lat: 43.5 + 0.018 * Math.sin(a),
      lon: -79.7 + 0.025 * Math.cos(a),
      alt_m: 1500,
    });
  }
  return pts;
}

function straightPoints(speedDegPerStep = 0.005) {
  const pts = [];
  for (let i = 0; i < 60; i++) {
    pts.push({ t: NOW - 300 + i * 5, lat: 43.2 + i * speedDegPerStep, lon: -79.7, alt_m: 9000 });
  }
  return pts;
}

// Lawnmower: 5 east/west legs of ~3.6 km joined by quick row steps.
function gridPoints() {
  const pts = [];
  let t = NOW - 1100;
  for (let leg = 0; leg < 5; leg++) {
    for (let i = 0; i <= 8; i++) {
      const f = leg % 2 === 0 ? i / 8 : 1 - i / 8;
      pts.push({ t, lat: 43.4 + leg * 0.004, lon: -79.8 + f * 0.045, alt_m: 900 });
      t += 20;
    }
  }
  return pts;
}

function goAroundPoints() {
  const pts = [];
  let t = NOW - 500;
  for (let i = 0; i < 20; i++) { // approach 1200 → 300 m
    pts.push({ t, lat: 43.3 + i * 0.002, lon: -79.6, alt_m: 1200 - i * 47 });
    t += 10;
  }
  for (let i = 0; i < 15; i++) { // climb-out 300 → 1050 m
    pts.push({ t, lat: 43.34 + i * 0.002, lon: -79.6, alt_m: 300 + i * 50 });
    t += 10;
  }
  return pts;
}

test("holding triggers on an orbit, not on straight flight", () => {
  assert.equal(detectHolding(orbitPoints(), NOW), true);
  assert.equal(detectHolding(straightPoints(), NOW), false);
});

test("survey grid triggers on lawnmower legs, not on an orbit", () => {
  assert.equal(detectSurveyGrid(gridPoints(), NOW), true);
  assert.equal(detectSurveyGrid(straightPoints(), NOW), false);
});

test("go-around triggers on descend-then-climb, not on cruise", () => {
  assert.equal(detectGoAround(goAroundPoints(), NOW), true);
  assert.equal(detectGoAround(straightPoints(), NOW), false);
});

test("formation pairs need proximity + matched velocity", () => {
  const mk = (lat, lon, gs, hdg) => ({
    icao24: `${lat}${lon}`,
    points: [
      { t: NOW - 30, lat: lat - 0.004, lon, alt_m: 3000 },
      { t: NOW - 2, lat, lon, alt_m: 3000 },
    ],
    vel: { gs_ms: gs, trackDeg: hdg, vrate_ms: 0 },
  });
  const a = mk(43.5, -79.7, 120, 10);
  const b = mk(43.503, -79.7, 118, 12);   // ~330 m north, same vector
  const c = mk(43.8, -79.2, 120, 10);     // far away
  const d = mk(43.5005, -79.701, 120, 190); // close but opposite heading
  const pairs = detectFormationPairs([a, b, c, d], NOW);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].includes(a) && pairs[0].includes(b));
});

test("detectBehaviors annotates badges in place", () => {
  const tr = { icao24: "abc", points: orbitPoints(), vel: { gs_ms: 80, trackDeg: 0, vrate_ms: 0 } };
  detectBehaviors([tr], NOW);
  assert.deepEqual(tr.behaviors, ["holding"]);
  assert.equal(tr.badges, "HOLD");
});
