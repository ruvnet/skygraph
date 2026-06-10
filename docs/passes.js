// Satellite pass timeline: 24 h pass prediction through the wasm
// SatPropagator.predict_passes (SGP4 stepped at 30 s in Rust, with a
// low-precision sun model so each pass carries a naked-eye "visible"
// flag — sunlit satellite against a dark observer sky). The side panel
// lists the next visible passes; the ⚙ drawer can arm a Notification-API
// alert 5 minutes before each visible pass (permission-gated).

const RECOMPUTE_S = 6 * 3600;  // refresh horizon twice per TLE cache life
const MIN_LIST_EL = 10;        // ignore grazing passes below 10° max el
const ALERT_LEAD_S = 300;

export function compassDir(az) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

export function fmtLocal(t) {
  return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export class PassPlanner {
  constructor(prop, names) {
    this.prop = prop;
    this.names = names;
    this.passes = [];
    this.computedAt = 0;
    this.alertsOn = false;
    this._alerted = new Set();
  }

  // One synchronous wasm call (~150 sats × 24 h @ 30 s ≈ 0.4 M SGP4 steps,
  // well under a second) — run after TLE load and then every 6 h, never
  // per frame.
  compute(nowT) {
    const out = this.prop.predict_passes(nowT, 24, 30);
    const ps = [];
    for (let i = 0; i + 6 < out.length; i += 7) {
      ps.push({
        sat: out[i], rise: out[i + 1], culm: out[i + 2], set: out[i + 3],
        maxEl: out[i + 4], azCulm: out[i + 5], visible: out[i + 6] > 0.5,
        name: this.names[out[i]] || `sat ${out[i]}`,
      });
    }
    ps.sort((a, b) => a.rise - b.rise);
    this.passes = ps;
    this.computedAt = nowT;
  }

  upcomingVisible(nowT, n = 10) {
    if (this.computedAt && nowT - this.computedAt > RECOMPUTE_S) this.compute(nowT);
    return this.passes
      .filter((p) => p.visible && p.set > nowT && p.maxEl >= MIN_LIST_EL)
      .slice(0, n);
  }

  // Render the "Upcoming passes" panel (textContent only — TLE names are
  // remote data).
  renderInto(container, nowT) {
    const list = this.upcomingVisible(nowT);
    container.innerHTML = "";
    if (!list.length) {
      const d = document.createElement("div");
      d.className = "reason";
      d.textContent = this.computedAt
        ? "no naked-eye passes in the next 24 h"
        : "predicting passes…";
      container.appendChild(d);
      return;
    }
    for (const p of list) {
      const d = document.createElement("div");
      d.className = "reason pass";
      const when = p.rise <= nowT ? "NOW" : `${fmtLocal(p.rise)}–${fmtLocal(p.set)}`;
      d.textContent =
        `✦ ${p.name} · ${when} · max ${Math.round(p.maxEl)}° ${compassDir(p.azCulm)}`;
      container.appendChild(d);
    }
  }

  // Permission-gated browser notification ~5 min before each visible pass.
  async enableAlerts() {
    if (!("Notification" in window)) return false;
    const perm = await Notification.requestPermission();
    this.alertsOn = perm === "granted";
    return this.alertsOn;
  }

  maybeNotify(nowT) {
    if (!this.alertsOn) return;
    for (const p of this.upcomingVisible(nowT)) {
      const lead = p.rise - nowT;
      const key = `${p.name}@${Math.round(p.rise)}`;
      if (lead > 0 && lead <= ALERT_LEAD_S && !this._alerted.has(key)) {
        this._alerted.add(key);
        try {
          new Notification(`✦ ${p.name} pass in ${Math.round(lead / 60)} min`, {
            body: `rises ${fmtLocal(p.rise)}, max ${Math.round(p.maxEl)}° ` +
              `${compassDir(p.azCulm)}, sets ${fmtLocal(p.set)}`,
          });
        } catch (_e) { /* notification construction can throw on some platforms */ }
      }
    }
  }
}
