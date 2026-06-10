// Real §15 vector novelty (full §13 embeddings) — the browser counterpart of
// src/indexer.rs. Each live track is embedded through wasm `embed_track`
// (canonical 32-dim §13 embedding; per-point motion derived in Rust by
// finite differences) and scored with wasm `novelty` (mean top-3 euclidean
// distance / the 1.2 indexer calibration; neutral 0.5 with no priors).
//
// Past embeddings persist in an IndexedDB rolling store (cap ~5 000, oldest
// pruned) so novelty survives reloads: a corridor flight seen an hour ago
// keeps scoring familiar now. Brute-force distance is fine at this scale.
// If IndexedDB is unavailable (private mode) the store runs RAM-only.

const DB_NAME = "skygraph-novelty-v1";
const STORE = "embeddings";
const DIM = 32;
const MIN_FIXES = 4;          // need ≥4 projected points to embed
const SELF_EXCLUDE_S = 3600;  // ignore own records newer than this
const PERSIST_MIN_S = 20;     // per-track snapshot cadence into the store

const idb = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

// Flatten a live track's projected points into the wasm embed_track shape:
// [t, lat, lon, alt_m, az_deg, el_deg, range_m] per point.
export function trackFlatPoints(tr) {
  const pts = tr.points.filter((p) => p.az !== undefined);
  const flat = new Float64Array(pts.length * 7);
  pts.forEach((p, i) => {
    const o = i * 7;
    flat[o] = p.t; flat[o + 1] = p.lat; flat[o + 2] = p.lon; flat[o + 3] = p.alt_m;
    flat[o + 4] = p.az; flat[o + 5] = p.el; flat[o + 6] = p.range;
  });
  return flat;
}

export class NoveltyStore {
  constructor(cap = 5000) {
    this.cap = cap;
    this.records = []; // [{at, icao24, emb: Float32Array}] oldest first
    this.db = null;
  }

  async open() {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () =>
        req.result.createObjectStore(STORE, { autoIncrement: true });
      this.db = await idb(req);
      const all = await idb(this.db.transaction(STORE).objectStore(STORE).getAll());
      this.records = all.map((r) => ({
        at: r.at, icao24: r.icao24, emb: new Float32Array(r.emb),
      }));
    } catch (_e) { this.db = null; /* RAM-only fallback */ }
    return this;
  }

  size() { return this.records.length; }

  // Score novelty for every track (sets tr.novelty + tr._emb), THEN append
  // this poll's embeddings — novelty is always relative to the past.
  update(wasm, tracks, nowT) {
    if (!wasm?.embedTrack) return;
    for (const tr of tracks) {
      const flat = trackFlatPoints(tr);
      if (flat.length < 7 * MIN_FIXES) { tr.novelty = null; continue; }
      try {
        tr._emb = wasm.embedTrack(flat, typeof tr.rssi === "number" ? tr.rssi : -20);
        tr.novelty = wasm.noveltyScore(tr._emb, this._pastFor(tr.icao24, nowT));
      } catch (_e) { tr.novelty = null; }
    }
    this._append(tracks, nowT);
  }

  // Flattened prior embeddings, excluding this aircraft's own recent
  // snapshots (an aircraft is never novel relative to itself mid-flight —
  // mirrors the indexer's exclude-own-track_id rule).
  _pastFor(icao24, nowT) {
    const keep = this.records.filter(
      (r) => r.icao24 !== icao24 || nowT - r.at > SELF_EXCLUDE_S);
    const flat = new Float32Array(keep.length * DIM);
    keep.forEach((r, i) => flat.set(r.emb, i * DIM));
    return flat;
  }

  _append(tracks, nowT) {
    const added = [];
    for (const tr of tracks) {
      if (!tr._emb) continue;
      if (tr._embSavedAt && nowT - tr._embSavedAt < PERSIST_MIN_S) continue;
      tr._embSavedAt = nowT;
      this.records.push({ at: nowT, icao24: tr.icao24, emb: tr._emb });
      added.push({ at: nowT, icao24: tr.icao24, emb: Array.from(tr._emb) });
    }
    const extra = this.records.length - this.cap;
    if (extra > 0) this.records.splice(0, extra);
    if (!this.db || !added.length) return;
    try {
      const os = this.db.transaction(STORE, "readwrite").objectStore(STORE);
      for (const rec of added) os.add(rec);
      os.count().onsuccess = (ev) => { // prune oldest beyond cap
        let drop = ev.target.result - this.cap;
        if (drop > 0) {
          os.openCursor().onsuccess = (e2) => {
            const cur = e2.target.result;
            if (cur && drop-- > 0) { cur.delete(); cur.continue(); }
          };
        }
      };
    } catch (_e) { /* quota / private mode — RAM store keeps working */ }
  }
}
