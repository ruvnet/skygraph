// Canvas2D rendering primitives for the all-sky dome — extracted from
// sky.js (which stays the app conductor). Pure drawing over already
// projected az/el points; the only import is the polar screen mapping.

import { polarScreenXY } from "./project.js";

export const BAND_COLORS = {
  "normal": "#3ddc84",
  "mildly unusual": "#e8d44d",
  "interesting": "#ff9f43",
  "strong anomaly": "#ff5252",
  "rare": "#d05aff",
};
export const LIVE_COLOR = "#5aa9ff"; // unscored live tracks
export const SAT_COLOR = "#cfd8ea";
export const SAT_VISIBLE_COLOR = "#ffe08a"; // sunlit satellite, dark sky
export const CONFLICT_COLOR = "#ff5252";
export const LINGER_SECS = 20;     // dot stays this long after the last sample
export const KT = 0.514444;        // m/s per knot

// Last point index with p.t <= t (binary search; points are ordered by t).
export function indexAt(tr, t) {
  if (t < tr.t0) return -1;
  let lo = 0, hi = tr.points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tr.points[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function drawSkyDome(ctx, w, h) {
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2;
  // Elevation rings at 0 / 30 / 60 degrees.
  for (const el of [0, 30, 60]) {
    const r = ((90 - el) / 90) * R;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = el === 0 ? "#27345c" : "#1a2542";
    ctx.lineWidth = el === 0 ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle = "#3d4d78";
    ctx.font = "10px monospace";
    ctx.fillText(`${el}°`, cx + 4, cy - r + 12);
  }
  // Cross hairs + compass labels (N up, E right, S down, W left).
  ctx.strokeStyle = "#16203c";
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();
  ctx.fillStyle = "#7e90bd";
  ctx.font = "bold 13px monospace";
  ctx.textAlign = "center";
  ctx.fillText("N", cx, cy - R + 16);
  ctx.fillText("S", cx, cy + R - 8);
  ctx.fillText("E", cx + R - 10, cy + 4);
  ctx.fillText("W", cx - R + 10, cy + 4);
  ctx.textAlign = "left";
}

// Draw one aircraft track at timeline t. `cfg` carries {trails, labels,
// trailLen} (the ⚙ drawer settings). Returns whether the dot is visible.
export function drawTrack(ctx, tr, t, w, h, selected, cfg) {
  const i = indexAt(tr, t);
  if (i < 0 || t > tr.t1 + LINGER_SECS) return false;
  // Fading trail.
  if (cfg.trails) {
    ctx.lineWidth = 1.5;
    for (let j = Math.max(1, i - cfg.trailLen); j <= i; j++) {
      const a = tr.points[j - 1], b = tr.points[j];
      const [x1, y1] = polarScreenXY(a.az, a.el, w, h);
      const [x2, y2, vis] = polarScreenXY(b.az, b.el, w, h);
      if (!vis && b.el < -2) continue;
      const age = (i - j) / cfg.trailLen;
      ctx.strokeStyle = tr.color;
      ctx.globalAlpha = 0.55 * (1 - age);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // Current dot — the smoothed dead-reckoned ghost glides between polls.
  let p = tr.points[i];
  let gone = t > tr.t1; // lingering after last sample
  if (gone && tr._ghost) { p = tr._ghost; gone = false; }
  const [x, y, visible] = polarScreenXY(p.az, p.el, w, h);
  if (!visible) return false;
  ctx.globalAlpha = gone ? Math.max(0, 1 - (t - tr.t1) / LINGER_SECS) : 1;
  ctx.fillStyle = tr.color;
  if (tr.category === "A7") {
    // Rotorcraft: small cross instead of a dot.
    ctx.fillRect(x - 5, y - 1.2, 10, 2.4);
    ctx.fillRect(x - 1.2, y - 5, 2.4, 10);
  } else {
    const r = selected ? 5 : tr.category === "A5" ? 4.6 : 3.5; // A5 = heavy
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  if (tr.emergency) {
    // Emergency squawk: double red ring.
    ctx.strokeStyle = "#ff5252";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
  }
  if (selected) {
    ctx.strokeStyle = tr.color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.stroke();
  }
  if (cfg.labels) {
    const vr = tr.vel ? tr.vel.vrate_ms : 0;
    const arrow = vr > 1.5 ? "↑" : vr < -1.5 ? "↓" : "";
    ctx.fillStyle = "#c7d2e8";
    ctx.font = "11px monospace";
    ctx.fillText(`${tr.label}${arrow} ${Math.round(p.alt_m)}m`, x + 12, y - 6);
  }
  ctx.globalAlpha = 1;
  return true;
}

// Dashed red line between a conflicting pair (current display positions).
export function drawConflictLine(ctx, pa, pb, w, h, label) {
  const [x1, y1, v1] = polarScreenXY(pa.az, pa.el, w, h);
  const [x2, y2, v2] = polarScreenXY(pb.az, pb.el, w, h);
  if (!v1 && !v2) return;
  ctx.save();
  ctx.strokeStyle = CONFLICT_COLOR;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = CONFLICT_COLOR;
  ctx.font = "11px monospace";
  ctx.fillText(`⚠ ${label}`, (x1 + x2) / 2 + 8, (y1 + y2) / 2 - 4);
  ctx.restore();
}

// Turn-aware predicted-path cone for the selected aircraft: dashed edges,
// solid centre line, over already projected {az, el} arrays.
export function drawCone(ctx, cone, w, h, color) {
  const stroke = (pts, dash) => {
    ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      if (p.el < -2) continue;
      const [x, y] = polarScreenXY(p.az, p.el, w, h);
      if (started) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); started = true; }
    }
    ctx.stroke();
  };
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;
  stroke(cone.left, [3, 3]);
  stroke(cone.right, [3, 3]);
  ctx.globalAlpha = 0.85;
  stroke(cone.center, []);
  ctx.setLineDash([]);
  ctx.restore();
}
