// Recorded replay of REAL traffic (the synthetic-day replay was deliberately
// removed — this only ever replays what the live feed actually saw).
//
// Every poll, freshly projected aircraft points are appended to an
// IndexedDB ring buffer capped at ~1 h. The footer scrubber re-renders the
// dome at a past wall-clock t from this buffer through the exact same
// drawTrack/indexAt path — recorded points carry t plus az/el/range, so no
// re-projection is needed. LIVE returns to the wall clock.

const DB_NAME = "skygraph-replay-v1";
const STORE = "points";
const WINDOW_S = 3600;
const PRUNE_EVERY_S = 60;

const idb = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

export class Recorder {
  constructor() { this.db = null; this._lastPrune = 0; }

  async open() {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const os = req.result.createObjectStore(STORE, { autoIncrement: true });
        os.createIndex("t", "t");
      };
      this.db = await idb(req);
    } catch (_e) { this.db = null; /* private mode — replay unavailable */ }
    return this;
  }

  get available() { return !!this.db; }

  // Append every projected point newer than the track's last recorded t.
  record(tracks, nowT) {
    if (!this.db) return;
    const rows = [];
    for (const tr of tracks) {
      for (const p of tr.points) {
        if (p.az === undefined || (tr._recT !== undefined && p.t <= tr._recT)) continue;
        rows.push({
          t: p.t, icao24: tr.icao24, label: tr.label || tr.icao24,
          category: tr.category || null, emergency: tr.emergency || null,
          lat: p.lat, lon: p.lon, alt_m: p.alt_m,
          az: p.az, el: p.el, range: p.range,
        });
      }
      const last = tr.points[tr.points.length - 1];
      if (last) tr._recT = last.t;
    }
    if (!rows.length) return;
    try {
      const os = this.db.transaction(STORE, "readwrite").objectStore(STORE);
      for (const r of rows) os.add(r);
    } catch (_e) { /* quota — stop growing, replay keeps what it has */ }
    if (nowT - this._lastPrune > PRUNE_EVERY_S) {
      this._lastPrune = nowT;
      this._prune(nowT - WINDOW_S);
    }
  }

  _prune(beforeT) {
    try {
      const idx = this.db.transaction(STORE, "readwrite")
        .objectStore(STORE).index("t");
      idx.openCursor(IDBKeyRange.upperBound(beforeT, true)).onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { cur.delete(); cur.continue(); }
      };
    } catch (_e) { /* best effort */ }
  }

  // Earliest recorded t (or null when the buffer is empty).
  async earliestT() {
    if (!this.db) return null;
    try {
      const idx = this.db.transaction(STORE).objectStore(STORE).index("t");
      const cur = await idb(idx.openCursor());
      return cur ? cur.value.t : null;
    } catch (_e) { return null; }
  }

  // Load the whole buffer and group it into renderable track shapes
  // ({icao24, label, category, emergency, points[{t,lat,lon,alt_m,az,el,
  // range}], t0, t1}) — drawTrack consumes these directly.
  async loadTracks() {
    if (!this.db) return [];
    let rows = [];
    try {
      rows = await idb(this.db.transaction(STORE).objectStore(STORE).getAll());
    } catch (_e) { return []; }
    const by = new Map();
    for (const r of rows) {
      let tr = by.get(r.icao24);
      if (!tr) {
        tr = { icao24: r.icao24, label: r.label, category: r.category,
               emergency: null, points: [], replay: true };
        by.set(r.icao24, tr);
      }
      tr.label = r.label;
      tr.points.push({ t: r.t, lat: r.lat, lon: r.lon, alt_m: r.alt_m,
                       az: r.az, el: r.el, range: r.range });
    }
    const out = [...by.values()];
    for (const tr of out) {
      tr.points.sort((a, b) => a.t - b.t);
      tr.t0 = tr.points[0].t;
      tr.t1 = tr.points[tr.points.length - 1].t;
    }
    return out;
  }
}
