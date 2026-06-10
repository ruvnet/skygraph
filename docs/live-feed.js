// RuView SkyGraph live data layer (ADR-199 — the dashboard's only data source).
//
// Polls public, key-free ADS-B + weather APIs and maintains rolling tracks in
// the canonical track shape ({icao24, callsign, points: [{t, lat, lon,
// alt_m}], anomaly, overhead}) consumed by sky.js, which projects and renders
// them on the all-sky plot in realtime.
//
// Source survey (probed 2026-06-09 with Origin: http://localhost:8000):
//   airplanes.live /v2/point   -> 200, Access-Control-Allow-Origin: *  PRIMARY
//   adsb.lol       /v2/lat/..  -> 200, same readsb shape but NO ACAO header
//                                 observed; kept as a long-shot fallback only
//   OpenSky        states/all  -> ACAO locked to opensky-network.org  REJECTED
//   open-meteo     /v1/forecast-> 200, ACAO: *                        WEATHER

const FT_TO_M = 0.3048;
const KT_TO_MS = 0.514444;

export const ADSB_POLL_MS = 5000;      // 12 req/min — well inside anon limits
export const WX_POLL_MS = 10 * 60e3;   // Open-Meteo current block updates ~15 min
const RADIUS_NM = 40;                  // search radius around the observer
const MAX_POINTS = 720;                // per-track cap (~96 min @ 8 s cadence)
const STALE_SECS = 120;                // drop tracks unseen for this long
const FETCH_TIMEOUT_MS = 6000;
const FTMIN_TO_MS = 0.00508;           // ft/min -> m/s (vertical rate)
const SMOOTH_TAU = 0.35;               // s — display smoothing time constant
const PREDICT_MAX_S = 20;              // dead-reckon horizon (= dot linger)

const ADSB_SOURCES = [
  { name: "airplanes.live",
    url: (o) => `https://api.airplanes.live/v2/point/${o.lat}/${o.lon}/${RADIUS_NM}` },
  { name: "adsb.lol",
    url: (o) => `https://api.adsb.lol/v2/lat/${o.lat}/lon/${o.lon}/dist/${RADIUS_NM}` },
];

// WMO weather interpretation codes -> short text (Open-Meteo `weather_code`).
const WMO = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog", 51: "drizzle", 53: "drizzle", 55: "drizzle",
  61: "rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "showers", 81: "showers", 82: "heavy showers", 85: "snow showers",
  86: "snow showers", 95: "thunderstorm", 96: "thunderstorm + hail", 99: "thunderstorm + hail",
};

function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .finally(() => clearTimeout(timer));
}

export class LiveFeed {
  constructor(obs, onUpdate) {
    this.obs = obs;
    this.onUpdate = onUpdate || (() => {});
    this.byIcao = new Map();   // icao24 -> rolling track (canonical shape)
    this.weather = null;       // latest Open-Meteo `current` block
    this.sourceIdx = 0;
    this.source = ADSB_SOURCES[0].name;
    this.lastOkAt = 0;         // epoch secs of last successful ADS-B poll
    this.failStreak = 0;
    this.running = false;
    this._timers = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._pollAdsb();
    this._pollWx();
    this._timers.push(setInterval(() => this._pollAdsb(), ADSB_POLL_MS));
    this._timers.push(setInterval(() => this._pollWx(), WX_POLL_MS));
  }

  stop() {
    this.running = false;
    this._timers.forEach(clearInterval);
    this._timers = [];
  }

  get trackList() { return [...this.byIcao.values()]; }

  statusText() {
    if (!this.lastOkAt) {
      return this.failStreak
        ? `LIVE · offline — no ADS-B source reachable (retrying every ${ADSB_POLL_MS / 1000}s)`
        : "LIVE · connecting…";
    }
    const age = Math.round(Date.now() / 1000 - this.lastOkAt);
    const stale = age > 30 ? ` · stale ${age}s` : "";
    return `LIVE · ${this.source} · ${this.byIcao.size} aircraft${stale}`;
  }

  weatherText() {
    const w = this.weather;
    if (!w) return "";
    const dir = String(Math.round(w.wind_direction_10m)).padStart(3, "0");
    const precip = w.precipitation > 0 ? ` · precip ${w.precipitation} mm` : "";
    return `wx ${w.temperature_2m}°C · wind ${Math.round(w.wind_speed_10m)} kn @ ${dir}°` +
      ` · cloud ${w.cloud_cover}% · ${WMO[w.weather_code] ?? `wmo ${w.weather_code}`}${precip}`;
  }

  // Detail lines for the side-panel weather card (no selection active).
  // METAR (aviationweather.gov) was probed 2026-06-10: no ACAO header, so
  // browsers cannot fetch it directly — Open-Meteo carries the extras.
  weatherLines() {
    const w = this.weather;
    if (!w) return ["weather: waiting for Open-Meteo…"];
    const dir = String(Math.round(w.wind_direction_10m)).padStart(3, "0");
    return [
      `temperature ${w.temperature_2m} °C · humidity ${w.relative_humidity_2m}%`,
      `wind ${Math.round(w.wind_speed_10m)} kn @ ${dir}° · gusts ${Math.round(w.wind_gusts_10m)} kn`,
      `pressure ${Math.round(w.surface_pressure)} hPa · cloud ${w.cloud_cover}%`,
      `${WMO[w.weather_code] ?? `wmo ${w.weather_code}`} · precip ${w.precipitation} mm`,
    ];
  }

  async _pollAdsb() {
    for (let k = 0; k < ADSB_SOURCES.length; k++) {
      const idx = (this.sourceIdx + k) % ADSB_SOURCES.length;
      const src = ADSB_SOURCES[idx];
      try {
        const body = await fetchJson(src.url(this.obs));
        if (!Array.isArray(body.ac)) throw new Error("unexpected shape");
        this.sourceIdx = idx;
        this.source = src.name;
        this.failStreak = 0;
        this.lastOkAt = Date.now() / 1000;
        this._ingest(body.ac, this.lastOkAt);
        this.onUpdate(this);
        return;
      } catch (_e) { /* CORS / timeout / shape — try the next source */ }
    }
    this.failStreak += 1;
    this._prune(Date.now() / 1000); // age out tracks while offline too
    this.onUpdate(this);            // surface offline status; canvas keeps last dots
  }

  _ingest(acList, nowSec) {
    for (const ac of acList) {
      if (typeof ac.lat !== "number" || typeof ac.lon !== "number") continue; // no position
      const icao = String(ac.hex || "").replace("~", "").toLowerCase();
      if (!icao) continue;
      let altFt = ac.alt_geom ?? ac.alt_baro;
      if (altFt === "ground") altFt = 0;
      if (typeof altFt !== "number" || !isFinite(altFt)) continue;
      const t = nowSec - (ac.seen_pos ?? ac.seen ?? 0); // Unix epoch seconds
      let tr = this.byIcao.get(icao);
      if (!tr) {
        tr = { icao24: icao, callsign: null, points: [], anomaly: null, overhead: false, live: true };
        this.byIcao.set(icao, tr);
      }
      const cs = (ac.flight || "").trim();
      if (cs) tr.callsign = cs;
      // Enrichment carried by readsb: type / registration / squawk /
      // wake category / receiver signal — shown in the table + details.
      if (ac.t) tr.type = ac.t;
      if (ac.r) tr.reg = ac.r;
      if (ac.squawk) tr.squawk = ac.squawk;
      if (ac.category) tr.category = ac.category;
      if (typeof ac.rssi === "number") tr.rssi = ac.rssi;
      tr.emergency =
        ac.emergency && ac.emergency !== "none" ? ac.emergency
        : ["7500", "7600", "7700"].includes(ac.squawk) ? `squawk ${ac.squawk}`
        : null;
      const last = tr.points[tr.points.length - 1];
      if (!last || t > last.t + 0.5) {
        tr.points.push({ t, lat: ac.lat, lon: ac.lon, alt_m: altFt * FT_TO_M });
        if (tr.points.length > MAX_POINTS) tr.points.splice(0, tr.points.length - MAX_POINTS);
      }
      // Velocity snapshot for between-poll dead reckoning in the renderer.
      if (typeof ac.gs === "number" && typeof ac.track === "number") {
        const vr = typeof ac.geom_rate === "number" ? ac.geom_rate
          : typeof ac.baro_rate === "number" ? ac.baro_rate : 0;
        tr.vel = { t, gs_ms: ac.gs * KT_TO_MS, trackDeg: ac.track, vrate_ms: vr * FTMIN_TO_MS };
      }
    }
    this._prune(nowSec);
  }

  _prune(nowSec) {
    for (const [icao, tr] of this.byIcao) {
      const last = tr.points[tr.points.length - 1];
      if (!last || nowSec - last.t > STALE_SECS) this.byIcao.delete(icao);
    }
  }

  async _pollWx() {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${this.obs.lat}&longitude=${this.obs.lon}` +
      "&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m," +
      "wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,weather_code" +
      "&wind_speed_unit=kn";
    try {
      this.weather = (await fetchJson(url)).current || null;
    } catch (_e) { /* keep last reading; header simply stays as-is */ }
    this.onUpdate(this);
  }
}

// Dead-reckon a display position `t - p.t` seconds past the last sample
// (flat-earth step is fine for <=20 s at airliner speeds; display only).
export function deadReckon(p, vel, t) {
  const dt = t - p.t;
  if (!vel || !(dt > 0) || dt > PREDICT_MAX_S) return null;
  const d = vel.gs_ms * dt;
  const brg = (vel.trackDeg * Math.PI) / 180;
  const lat = p.lat + (d * Math.cos(brg)) / 111320;
  const lon = p.lon + (d * Math.sin(brg)) / (111320 * Math.cos((p.lat * Math.PI) / 180));
  return { t, lat, lon, alt_m: p.alt_m + (vel.vrate_ms || 0) * dt };
}

// Smoothed display position for `tr` at wall-clock `tNow`: dead-reckoned
// target, eased exponentially (SMOOTH_TAU) so dots glide at frame rate and
// absorb the correction when a fresh sample lands instead of snapping.
export function displayPoint(tr, tNow) {
  const last = tr.points[tr.points.length - 1];
  if (!last || tNow - last.t > PREDICT_MAX_S) { tr._disp = null; return null; }
  const target = deadReckon(last, tr.vel, tNow) || last;
  const prev = tr._disp;
  if (!prev || !(tNow > tr._dispT)) {
    tr._disp = { t: tNow, lat: target.lat, lon: target.lon, alt_m: target.alt_m };
    tr._dispT = tNow;
    return tr._disp;
  }
  const a = 1 - Math.exp(-(tNow - tr._dispT) / SMOOTH_TAU);
  prev.lat += (target.lat - prev.lat) * a;
  prev.lon += (target.lon - prev.lon) * a;
  prev.alt_m += (target.alt_m - prev.alt_m) * a;
  prev.t = tNow;
  tr._dispT = tNow;
  return prev;
}

// Incrementally sync the live track table (call / alt / hdg / range / age):
// rebuild rows only when the track set changes, otherwise update cells in
// place — keeps hover/selection stable while the numbers stay realtime.
// Callsigns are untrusted API data, so they go through textContent, never
// innerHTML.
export function syncLiveTable(feed, tbody, liveRows, onSelect) {
  const list = feed.trackList;
  for (const tr of list) tr.label = tr.callsign || tr.icao24;
  list.sort((a, b) => a.label.localeCompare(b.label));
  const sig = list.map((tr) => tr.icao24).join(",");
  if (sig !== tbody._liveSig) {
    tbody._liveSig = sig;
    tbody.innerHTML = "";
    liveRows.clear();
    for (const tr of list) {
      const row = document.createElement("tr");
      row.className = "track-row";
      row.innerHTML = "<td></td><td></td><td></td><td></td><td></td>";
      row.cells[0].textContent = tr.label;
      row.addEventListener("click", () => onSelect(tr));
      tbody.appendChild(row);
      liveRows.set(tr, {
        row, nameTd: row.cells[0], altTd: row.cells[1], hdgTd: row.cells[2],
        rngTd: row.cells[3], ageTd: row.cells[4],
      });
    }
  }
  const now = Date.now() / 1000;
  for (const tr of list) {
    const e = liveRows.get(tr);
    if (!e) continue;
    const last = tr.points[tr.points.length - 1];
    const p = tr._disp || last;
    const vr = tr.vel ? tr.vel.vrate_ms : 0;
    e.nameTd.textContent =
      (tr.emergency ? "⚠ " : "") + tr.label + (tr.badges ? ` [${tr.badges}]` : "");
    e.nameTd.style.color = tr.emergency ? "#ff5252" : tr.anomaly ? tr.color : "";
    e.altTd.textContent =
      String(Math.round(p.alt_m)) + (vr > 1.5 ? " ↑" : vr < -1.5 ? " ↓" : "");
    e.hdgTd.textContent = tr.vel ? `${Math.round(tr.vel.trackDeg)}°` : "—";
    e.rngTd.textContent = last.range !== undefined ? (last.range / 1000).toFixed(1) : "—";
    e.ageTd.textContent = String(Math.max(0, Math.round(now - last.t)));
  }
}
