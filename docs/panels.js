// Side-panel renderers (details card + satellite table) — extracted from
// sky.js. Every remote string goes through esc()/textContent; numbers are
// formatted locally.

import { KT, SAT_COLOR, SAT_VISIBLE_COLOR } from "./draw.js";
import { routeLines } from "./route-info.js";

const BEHAVIOR_TEXT = {
  holding: "holding pattern", grid: "survey-grid pattern",
  goaround: "go-around", formation: "formation flight",
};

const esc = (x) => String(x).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const line = (text, color) =>
  `<div class="reason" style="border-color:${color}">${text}</div>`;

// v: {details, selected, selectedSat, satsAbove, satNames, sun, feed,
//     spaceWx, noveltySize, conflicts, requestRoute}
export function renderDetails(v) {
  const { details, sun } = v;
  if (v.selectedSat >= 0) {
    const s = v.satsAbove.find((q) => q.i === v.selectedSat);
    const who =
      `<div class="who">${esc(v.satNames[v.selectedSat])} (satellite — CelesTrak)</div>`;
    const c = s?.visibleNow ? SAT_VISIBLE_COLOR : SAT_COLOR;
    const lines = s ? [
      `position: az ${Math.round(s.az)}° · el ${s.el.toFixed(1)}° · range ${(s.range / 1000).toFixed(0)} km`,
      `orbit altitude ${(s.alt / 1000).toFixed(0)} km · SGP4 propagation in sky-monitor-wasm`,
      s.visibleNow ? "✦ visible now — sunlit against a dark sky"
        : sun.el < -6 ? "in Earth's shadow — not naked-eye visible"
        : "sky too bright for naked-eye visibility",
    ] : ["below the horizon"];
    details.innerHTML = who + lines.map((l) => line(l, c)).join("");
    return;
  }
  if (!v.selected) {
    // Weather card while nothing is selected (Open-Meteo + NOAA SWPC Kp).
    const who =
      '<div class="who">conditions — Open-Meteo + NOAA SWPC (select a row for object details)</div>';
    const sunLine = `sun el ${sun.el.toFixed(1)}° · ` +
      (sun.el > 0 ? "day" : sun.el > -6 ? "civil twilight" : "dark sky");
    details.innerHTML = who +
      [...v.feed.weatherLines(), ...v.spaceWx.lines(), sunLine]
        .map((l) => line(l, "#3d4d78")).join("");
    return;
  }
  const tr = v.selected;
  const last = tr.points[tr.points.length - 1];
  const age = Math.max(0, Math.round(Date.now() / 1000 - last.t));
  const who = `<div class="who">${esc(tr.label)} (icao24 ${esc(tr.icao24)})</div>`;
  const c = tr.color;
  const lines = [];
  if (tr.emergency) lines.push(`⚠ EMERGENCY: ${esc(tr.emergency)}`);
  for (const cf of v.conflicts) {
    if (cf.a !== tr && cf.b !== tr) continue;
    const other = cf.a === tr ? cf.b : cf.a;
    lines.push(`⚠ CPA with ${esc(other.label || other.icao24)} in ${Math.round(cf.t)} s — ` +
      `${Math.round(cf.dh)} m horizontal · ${Math.round(cf.dv)} m vertical`);
  }
  lines.push(
    [tr.type && `type ${esc(tr.type)}`, tr.reg && `reg ${esc(tr.reg)}`,
      tr.squawk && `squawk ${esc(tr.squawk)}`, tr.category && `cat ${esc(tr.category)}`]
      .filter(Boolean).join(" · ") || "no airframe metadata yet",
    `position: az ${Math.round(last.az)}° · el ${last.el.toFixed(1)}° · range ${(last.range / 1000).toFixed(1)} km`,
    `altitude ${Math.round(last.alt_m)} m` +
      (tr.vel ? ` · gs ${Math.round(tr.vel.gs_ms / KT)} kn · hdg ${Math.round(tr.vel.trackDeg)}°` +
        ` · v/s ${(tr.vel.vrate_ms || 0).toFixed(1)} m/s` : ""),
    `${tr.points.length} samples · last seen ${age} s ago`,
  );
  if (tr.behaviors?.length) {
    lines.push("behavior: " + tr.behaviors.map((k) => BEHAVIOR_TEXT[k] || k).join(" · "));
  }
  if (tr.callsign) {
    // adsbdb route enrichment — fetched once per selection, 24 h cache.
    if (tr._route === undefined) {
      v.requestRoute(tr);
      lines.push("route: looking up…");
    } else {
      lines.push(...routeLines(tr._route).map(esc));
    }
  }
  if (tr.anomaly) {
    lines.push(`§15 score ${tr.anomaly.score.toFixed(3)} — ${esc(tr.anomaly.band)}`);
    for (const r of tr.anomaly.reasons) lines.push(esc(r));
  } else {
    lines.push("unscored — needs ≥6 concurrent tracks for a live §15 baseline");
  }
  if (typeof tr.novelty === "number") {
    lines.push(`vector novelty ${tr.novelty.toFixed(2)} — §13 embedding vs ` +
      `${v.noveltySize} stored tracks (IndexedDB)`);
  }
  details.innerHTML = who +
    lines.map((l) => line(l, tr.emergency ? "#ff5252" : c)).join("");
}

// Satellite table (name / el / az / range / alt), highest elevation first.
// v: {satTbody, satsAbove, satNames, selectedSat}; onSelect(i).
export function renderSatTable(v, onSelect) {
  const list = [...v.satsAbove].sort((a, b) => b.el - a.el).slice(0, 80);
  v.satTbody.innerHTML = "";
  for (const s of list) {
    const row = document.createElement("tr");
    row.className = "track-row" + (s.i === v.selectedSat ? " active" : "");
    row.innerHTML = "<td></td><td></td><td></td><td></td><td></td>";
    row.cells[0].textContent = (s.visibleNow ? "✦ " : "") + v.satNames[s.i];
    if (s.visibleNow) row.cells[0].style.color = SAT_VISIBLE_COLOR;
    row.cells[1].textContent = `${s.el.toFixed(1)}°`;
    row.cells[2].textContent = `${Math.round(s.az)}°`;
    row.cells[3].textContent = (s.range / 1000).toFixed(0);
    row.cells[4].textContent = (s.alt / 1000).toFixed(0);
    row.addEventListener("click", () => onSelect(s.i));
    v.satTbody.appendChild(row);
  }
}
