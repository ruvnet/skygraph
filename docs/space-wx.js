// Space weather: NOAA SWPC planetary K index for the weather card.
//
// Source survey (probed 2026-06-10 with Origin: http://localhost:8000):
//   services.swpc.noaa.gov/json/planetary_k_index_1m.json
//     -> 200, Access-Control-Allow-Origin: *  (usable from the browser)
// (Same CORS posture as the METAR note in live-feed.js — aviationweather.gov
// is blocked, SWPC is open.)
//
// The 1-minute product regenerates server-side every minute but Kp is a
// 3-hourly planetary index — polling every 15 min is plenty. Any failure
// keeps the last reading; offline the card simply omits the Kp line.

const URL = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const POLL_MS = 15 * 60e3;
const FETCH_TIMEOUT_MS = 8000;
const AURORA_KP = 7; // Kp ≥ 7 pushes the auroral oval to ~43°N (observer lat)

export class SpaceWeather {
  constructor(onUpdate) {
    this.onUpdate = onUpdate || (() => {});
    this.kp = null;
    this.at = null;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_MS);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _poll() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(URL, { signal: ctl.signal, headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = await r.json();
      const last = Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
      if (last && isFinite(Number(last.estimated_kp))) {
        this.kp = Number(last.estimated_kp);
        this.at = last.time_tag;
        this.onUpdate(this);
      }
    } catch (_e) { /* graceful skip — keep last reading */ }
    finally { clearTimeout(timer); }
  }

  level() {
    const k = this.kp;
    if (k === null) return "";
    if (k < 4) return "quiet";
    if (k < 5) return "active";
    if (k < 6) return "G1 minor storm";
    if (k < 7) return "G2 moderate storm";
    if (k < 8) return "G3 strong storm";
    if (k < 9) return "G4 severe storm";
    return "G5 extreme storm";
  }

  // Lines for the weather card (details panel, nothing selected).
  lines() {
    if (this.kp === null) return [];
    const out = [`geomagnetic Kp ${this.kp.toFixed(2)} — ${this.level()} · NOAA SWPC`];
    if (this.kp >= AURORA_KP) {
      out.push("⚠ aurora possible at this latitude (43°N) — check the northern horizon");
    }
    return out;
  }
}
