// RuView SkyGraph dashboard (ADR-199 presentation plane) — realtime, with
// recorded replay of real traffic.
//
// Live ADS-B + Open-Meteo (./live-feed.js), satellites (./sat-feed.js TLEs +
// wasm SGP4, optional WebGPU sprite layer ./gpu-sats.js), sun & moon
// (./astro.js), §15 anomaly scoring with REAL §13 vector novelty
// (./score-live.js + ./novelty.js + IndexedDB), behavior badges
// (./behavior.js), CPA conflict prediction (./conflict.js), satellite pass
// timeline (./passes.js), adsbdb route enrichment (./route-info.js), NOAA
// space weather (./space-wx.js) and an IndexedDB ring-buffer replay of the
// last hour of real traffic (./record.js). Offline, the dome stays up and
// the status line reports retrying. Rendering primitives live in ./draw.js,
// the ⚙ drawer in ./settings.js, the side panel in ./panels.js.

import { geodeticToEcef, loadWasmEngine, observerFrameJs, polarScreenXY } from "./project.js";
import { LiveFeed, displayPoint, syncLiveTable } from "./live-feed.js";
import { moonPosition, satSunlit, sunPosition } from "./astro.js";
import { scoreAll } from "./score-live.js";
import {
  BAND_COLORS, drawConflictLine, drawCone, drawSkyDome, drawTrack,
  LIVE_COLOR, SAT_COLOR, SAT_VISIBLE_COLOR,
} from "./draw.js";
import { CFG, initDrawer, saveSettings } from "./settings.js";
import { renderDetails, renderSatTable } from "./panels.js";
import { NoveltyStore } from "./novelty.js";
import { detectBehaviors } from "./behavior.js";
import { detectConflicts, predictCone } from "./conflict.js";
import { PassPlanner } from "./passes.js";
import { routeFor } from "./route-info.js";
import { SpaceWeather } from "./space-wx.js";
import { Recorder } from "./record.js";
import { GpuSats } from "./gpu-sats.js";
import { loadTles } from "./sat-feed.js";

// Reference observer (matches src/config.rs ObserverConfig defaults).
const OBSERVER = { name: "oakville_node", lat: 43.4675, lon: -79.6877, alt_m: 100.0 };

async function main() {
  const canvas = document.getElementById("sky");
  const gpuCanvas = document.getElementById("sky-gpu");
  const ctx = canvas.getContext("2d");
  const clock = document.getElementById("clock");
  const wxLabel = document.getElementById("wx");
  const liveStatus = document.getElementById("live-status");
  const satStatus = document.getElementById("sat-status");
  const tbody = document.querySelector("#track-table tbody");
  const satTbody = document.querySelector("#sat-table tbody");
  const details = document.getElementById("details");
  const passList = document.getElementById("pass-list");
  document.getElementById("observer-label").textContent =
    `observer: ${OBSERVER.name} (${OBSERVER.lat.toFixed(4)}, ${OBSERVER.lon.toFixed(4)}, ${OBSERVER.alt_m} m)`;

  // Prefer wasm when ./pkg is present (projection + SGP4 + scoring + §13).
  const obsEcef = geodeticToEcef(OBSERVER.lat, OBSERVER.lon, OBSERVER.alt_m);
  const wasm = await loadWasmEngine(OBSERVER);
  const scorer = wasm?.AnomalyScorer ? new wasm.AnomalyScorer() : null;
  document.getElementById("engine").textContent = wasm
    ? `projection: wasm (sky-monitor-wasm ${wasm.version})`
    : "projection: JS fallback (build ./pkg for wasm)";

  let t = Date.now() / 1000; // displayed timeline (wall clock, or replay t)
  let sun = sunPosition(t, OBSERVER.lat, OBSERVER.lon);
  let selected = null;       // selected aircraft track
  let selectedSat = -1;      // selected satellite index (exclusive with above)
  let lastStatusSec = 0;
  let lastPassRender = 0;
  let conflicts = [];
  const liveRows = new Map();

  // Stores: §13/§15 novelty embeddings + the replay ring buffer.
  const novelty = await new NoveltyStore().open();
  const recorder = await new Recorder().open();
  const spaceWx = new SpaceWeather(() => showDetails());
  spaceWx.start();

  // --- Satellite layer (wasm SGP4; stays off without ./pkg) -------------------
  let satProp = null, satNames = [], satsAbove = [], passes = null;
  let satGen = 0;
  async function loadSats(group) {
    if (!wasm?.SatPropagator) {
      satStatus.textContent = "sats: off (build ./pkg for wasm SGP4)";
      return;
    }
    const gen = ++satGen;
    satProp = null; passes = null; satNames = []; selectedSat = -1;
    satStatus.textContent = `sats: loading TLEs (${group})…`;
    try {
      const tle = await loadTles(group);
      if (gen !== satGen) return; // superseded by a newer group switch
      if (!tle) { satStatus.textContent = "sats: offline — no TLE source"; return; }
      const prop = new wasm.SatPropagator(OBSERVER.lat, OBSERVER.lon, OBSERVER.alt_m);
      let n = 0;
      for (const s of tle.sats) if (prop.add_tle(s.name, s.l1, s.l2)) n++;
      satNames = Array.from({ length: n }, (_, i) => prop.name(i));
      satProp = prop;
      satStatus.textContent = `sats: ${n} TLEs (${tle.source})`;
      // 24 h pass horizon: one wasm call, then a 6 h refresh inside
      // upcomingVisible(). Skipped for starlink (pass lists make no sense
      // for a 7 000-sat mesh and the prediction would take seconds).
      if (group !== "starlink") {
        passes = new PassPlanner(prop, satNames);
        passes.compute(Date.now() / 1000);
      }
      passes ? passes.renderInto(passList, Date.now() / 1000)
             : (passList.innerHTML = '<div class="reason">pass list off for starlink</div>');
    } catch (_e) {
      if (gen === satGen) satStatus.textContent = "sats: unavailable";
    }
  }

  // --- WebGPU satellite layer (experimental, auto-fallback) -------------------
  let gpu = null;
  async function setWebgpu(on) {
    if (!on) {
      gpu?.dispose();
      gpu = null;
      return true;
    }
    const g = new GpuSats();
    if (await g.init(gpuCanvas)) { gpu = g; return true; }
    satStatus.textContent = "sats: WebGPU unavailable — Canvas2D fallback";
    return false;
  }

  const drawerCtl = initDrawer({
    onWebgpu: setWebgpu,
    onTleGroup: (g) => loadSats(g),
    onPassAlerts: async () => (passes ? passes.enableAlerts() : false),
  });
  if (CFG.webgpuSats) {
    setWebgpu(true).then((ok) => {
      if (!ok) {
        CFG.webgpuSats = false;
        saveSettings();
        document.getElementById("opt-webgpu").checked = false;
        drawerCtl.syncTleOptions();
      }
    });
  }
  loadSats(CFG.tleGroup);

  // Propagate + draw satellites at timeline t. Canvas2D diamonds by
  // default; with the WebGPU toggle the same projected positions go to the
  // instanced sprite overlay instead (labels stay off there — point cloud).
  let gpuInst = new Float32Array(4096);
  function drawSats(w, h, dpr) {
    const out = satProp.positions(t);
    const dark = sun.el < -6; // civil twilight or darker
    const above = [];
    let gpuN = 0;
    if (gpu && gpuInst.length < (out.length / 6) * 4) {
      gpuInst = new Float32Array((out.length / 6) * 4);
    }
    for (let i = 0; i * 6 < out.length; i++) {
      const el = out[i * 6 + 4];
      if (!isFinite(el) || el <= 0) continue;
      const az = out[i * 6 + 3];
      const visibleNow =
        dark && satSunlit(out[i * 6], out[i * 6 + 1], out[i * 6 + 2], sun.dir);
      const [x, y] = polarScreenXY(az, el, w, h);
      const sel = i === selectedSat;
      if (gpu) {
        const o = gpuN * 4;
        gpuInst[o] = x; gpuInst[o + 1] = y;
        gpuInst[o + 2] = sel ? 5 : visibleNow ? 4 : 2.8;
        gpuInst[o + 3] = visibleNow ? 1 : 0;
        gpuN++;
      } else {
        const half = sel ? 4 : visibleNow ? 3.5 : 2.5;
        ctx.fillStyle = sel ? "#ffffff" : visibleNow ? SAT_VISIBLE_COLOR : SAT_COLOR;
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
        ctx.fillRect(-half, -half, half * 2, half * 2);
        ctx.restore();
        if (CFG.labels) {
          ctx.fillStyle = visibleNow ? SAT_VISIBLE_COLOR : "#8b97b8";
          ctx.font = "10px monospace";
          ctx.fillText(satNames[i], x + 9, y + 3);
        }
      }
      above.push({ i, az, el, range: out[i * 6 + 5], alt: out[i * 6 + 2], visibleNow });
    }
    if (gpu) gpu.draw(gpuInst, gpuN, w, h, dpr);
    return above;
  }

  function drawSunMoon(w, h) {
    if (sun.el > -0.8) {
      const [x, y] = polarScreenXY(sun.az, sun.el, w, h);
      ctx.fillStyle = "#ffd75e";
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(255, 215, 94, 0.35)";
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke();
      if (CFG.labels) { ctx.fillStyle = "#d9b84d"; ctx.font = "10px monospace"; ctx.fillText("sun", x + 14, y + 3); }
    }
    const moon = moonPosition(t, OBSERVER.lat, OBSERVER.lon);
    if (moon.el > -0.8) {
      const [x, y] = polarScreenXY(moon.az, moon.el, w, h);
      ctx.fillStyle = "#dde4f2";
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill();
      if (CFG.labels) { ctx.fillStyle = "#9aa6c4"; ctx.font = "10px monospace"; ctx.fillText("moon", x + 12, y + 3); }
    }
  }

  // Project aircraft points that arrived since the last poll.
  function projectNew(tr) {
    const fresh = tr.points.filter((p) => p.az === undefined);
    if (fresh.length && wasm) {
      const flat = new Float64Array(fresh.length * 3);
      fresh.forEach((p, i) => { flat[i * 3] = p.lat; flat[i * 3 + 1] = p.lon; flat[i * 3 + 2] = p.alt_m; });
      const out = wasm.projectBatch(flat); // [az, el, range, bearing] * N
      fresh.forEach((p, i) => { p.az = out[i * 4]; p.el = out[i * 4 + 1]; p.range = out[i * 4 + 2]; });
    } else {
      for (const p of fresh) {
        const [az, el, range] = observerFrameJs(OBSERVER, obsEcef, p.lat, p.lon, p.alt_m);
        p.az = az; p.el = el; p.range = range;
      }
    }
    tr.t0 = tr.points[0].t;
    tr.t1 = tr.points[tr.points.length - 1].t;
    tr.label = tr.callsign || tr.icao24;
  }

  // Smoothed dead-reckoned display position, re-projected each frame.
  function reckonGhost(tr, tNow) {
    const g = displayPoint(tr, tNow);
    if (g) {
      const [az, el] = observerFrameJs(OBSERVER, obsEcef, g.lat, g.lon, g.alt_m);
      g.az = az; g.el = el;
    }
    tr._ghost = g;
  }

  // Project a prediction cone's lat/lon paths into az/el for drawing.
  function projectCone(cone) {
    const proj = (pts) => pts.map((p) => {
      const [az, el] = observerFrameJs(OBSERVER, obsEcef, p.lat, p.lon, p.alt_m);
      return { az, el };
    });
    return { center: proj(cone.center), left: proj(cone.left), right: proj(cone.right) };
  }

  // adsbdb lookup on selection only (24 h localStorage cache inside).
  function requestRoute(tr) {
    if (!tr.callsign || tr._routePending) return;
    tr._routePending = true;
    routeFor(tr.callsign).then((r) => {
      tr._route = r;
      if (selected === tr) showDetails();
    });
  }

  function showDetails() {
    renderDetails({
      details, selected, selectedSat, satsAbove, satNames, sun,
      feed, spaceWx, noveltySize: novelty.size(), conflicts, requestRoute,
    });
  }

  function syncSatTable() {
    renderSatTable({ satTbody, satsAbove, satNames, selectedSat }, (i) => {
      selectedSat = selectedSat === i ? -1 : i;
      selected = null; // aircraft and satellite selection are exclusive
      showDetails();
    });
  }

  function syncTable() {
    syncLiveTable(feed, tbody, liveRows, (tr) => {
      selected = selected === tr ? null : tr;
      selectedSat = -1; // aircraft and satellite selection are exclusive
      showDetails();
    });
  }

  // --- Feed --------------------------------------------------------------------
  let emergencyPrefix = "";
  function statusLine(f) {
    const cpa = conflicts.length ? `⚠ CPA alert (${conflicts.length} pair${conflicts.length > 1 ? "s" : ""}) · ` : "";
    return emergencyPrefix + cpa + f.statusText();
  }

  function onFeedUpdate(f) {
    const nowT = Date.now() / 1000;
    for (const tr of f.trackList) projectNew(tr);
    novelty.update(wasm, f.trackList, nowT);  // §13 embed + §15 novelty (tr.novelty)
    scoreAll(scorer, f.trackList);            // §15 via wasm, novelty-bearing
    detectBehaviors(f.trackList, nowT);       // HOLD / GRID / GO-AROUND / FORM
    conflicts = CFG.conflicts ? detectConflicts(f.trackList, nowT) : [];
    recorder.record(f.trackList, nowT);       // replay ring buffer (~1 h)
    let emergency = null;
    for (const tr of f.trackList) {
      tr.color = tr.anomaly ? BAND_COLORS[tr.anomaly.band] || LIVE_COLOR : LIVE_COLOR;
      if (tr.emergency && !emergency) emergency = tr;
    }
    emergencyPrefix = emergency
      ? `⚠ ${emergency.emergency} ${emergency.callsign || emergency.icao24} · ` : "";
    liveStatus.textContent = statusLine(f);
    wxLabel.textContent = f.weatherText();
    if (selected && !f.byIcao.has(selected.icao24)) {
      selected = null; // selected track aged out
    }
    syncTable();
    showDetails();
  }

  const feed = new LiveFeed(OBSERVER, onFeedUpdate);
  feed.start();
  liveStatus.textContent = feed.statusText();

  // --- Replay (footer scrubber over the recorded ring buffer) -------------------
  const replay = { active: false, t: 0, tracks: [] };
  const replayBtn = document.getElementById("replay-toggle");
  const scrub = document.getElementById("replay-scrub");
  const liveBtn = document.getElementById("replay-live");

  async function enterReplay() {
    const t0 = await recorder.earliestT();
    if (t0 === null) {
      replayBtn.textContent = "⏪ nothing recorded yet";
      setTimeout(() => { replayBtn.textContent = "⏪ replay"; }, 1800);
      return;
    }
    replay.tracks = await recorder.loadTracks();
    for (const tr of replay.tracks) tr.color = LIVE_COLOR;
    scrub.min = String(Math.ceil(t0));
    scrub.max = String(Math.floor(Date.now() / 1000));
    scrub.value = scrub.max;
    replay.t = Number(scrub.value);
    replay.active = true;
    selected = null;
    document.body.classList.add("replaying");
    replayBtn.textContent = "⏪ recording continues…";
  }

  function exitReplay() {
    replay.active = false;
    replay.tracks = [];
    replayBtn.textContent = "⏪ replay";
    document.body.classList.remove("replaying");
  }

  replayBtn.addEventListener("click", () => (replay.active ? exitReplay() : enterReplay()));
  liveBtn.addEventListener("click", exitReplay);
  scrub.addEventListener("input", () => { replay.t = Number(scrub.value); });

  // --- Render loop ---------------------------------------------------------------
  function render() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawSkyDome(ctx, w, h);
    if (CFG.sunmoon) drawSunMoon(w, h);
    const tracks = replay.active ? replay.tracks : feed.trackList;
    if (CFG.aircraft) {
      for (const tr of tracks) {
        if (!tr.points.length || tr.points[tr.points.length - 1].az === undefined) continue;
        if (!replay.active) reckonGhost(tr, t);
        const visible = drawTrack(ctx, tr, t, w, h, tr === selected, CFG);
        if (!replay.active) {
          const entry = liveRows.get(tr);
          if (entry) {
            entry.row.classList.toggle("live", visible);
            entry.row.classList.toggle("active", tr === selected);
          }
        }
      }
    }
    if (!replay.active && CFG.conflicts) {
      for (const c of conflicts) {
        const pa = c.a._ghost || c.a.points[c.a.points.length - 1];
        const pb = c.b._ghost || c.b.points[c.b.points.length - 1];
        if (pa?.az !== undefined && pb?.az !== undefined) {
          drawConflictLine(ctx, pa, pb, w, h, `${Math.round(c.dh)} m in ${Math.round(c.t)} s`);
        }
      }
      if (selected) {
        const cone = predictCone(selected, t);
        if (cone) drawCone(ctx, projectCone(cone), w, h, selected.color || LIVE_COLOR);
      }
    }
    if (satProp && CFG.satellites) {
      satsAbove = drawSats(w, h, dpr);
    } else {
      satsAbove = [];
      if (gpu) gpu.draw(gpuInst, 0, w, h, dpr); // clear the overlay
    }
    const wallSec = Math.floor(Date.now() / 1000);
    if (wallSec !== lastStatusSec) {
      lastStatusSec = wallSec; // 1 Hz: sun, status, tables, details, passes
      sun = sunPosition(t, OBSERVER.lat, OBSERVER.lon);
      const vis = satsAbove.filter((s) => s.visibleNow).length;
      if (satProp) {
        satStatus.textContent = `sats: ${satNames.length} TLEs · ${satsAbove.length} overhead` +
          (vis ? ` · ${vis} ✦ visible` : "") + (gpu ? " · WebGPU" : "");
      }
      liveStatus.textContent = statusLine(feed);
      syncTable();
      syncSatTable();
      showDetails();
      if (passes) {
        passes.maybeNotify(wallSec);
        if (wallSec - lastPassRender >= 30) {
          lastPassRender = wallSec;
          passes.renderInto(passList, wallSec);
        }
      }
    }
    clock.textContent =
      new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) +
      (replay.active ? " UTC · REPLAY" : " UTC · LIVE");
  }

  function tick() {
    t = replay.active ? replay.t : Date.now() / 1000;
    render();
    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", render);
  requestAnimationFrame(tick);
}

main();
