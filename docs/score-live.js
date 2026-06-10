// Live §15 anomaly scoring through the wasm AnomalyScorer (the documented
// ADR-199 follow-up). Each live track is summarized into the exact
// TrackSummary shape (src/anomaly.rs) and scored against a baseline built
// from the *other* current tracks — a browser approximation of §26
// ("baseline before alerting"): nothing is scored until at least
// MIN_BASELINE other tracks exist. Vector novelty comes from ./novelty.js
// (wasm §13 embeddings against the IndexedDB store); cross-sensor
// confirmation stays 0 in the browser (no second modality).

const MIN_BASELINE = 5;
const DEFAULT_RSSI_DBFS = -20; // when the feed carries no rssi field

export function summarize(tr) {
  let altSum = 0, minRange = Infinity, maxEl = -90;
  for (const p of tr.points) {
    altSum += p.alt_m;
    if (p.range < minRange) minRange = p.range;
    if (p.el > maxEl) maxEl = p.el;
  }
  return {
    icao24: tr.icao24,
    callsign: tr.callsign || "",
    mean_alt_m: altSum / tr.points.length,
    dominant_heading_deg: tr.vel ? tr.vel.trackDeg : 0,
    start_hour: new Date(tr.t0 * 1000).getUTCHours(),
    mean_signal_dbfs: typeof tr.rssi === "number" ? tr.rssi : DEFAULT_RSSI_DBFS,
    min_range_m: isFinite(minRange) ? minRange : 0,
    max_elevation_deg: maxEl,
  };
}

// Score every track in place (tr.anomaly = {score, band, reasons} | null).
export function scoreAll(scorer, tracks) {
  if (!scorer || tracks.length < MIN_BASELINE + 1) {
    for (const tr of tracks) tr.anomaly = null;
    return;
  }
  const summaries = tracks.map(summarize);
  for (let i = 0; i < tracks.length; i++) {
    try {
      scorer.baseline_from(summaries.filter((_, j) => j !== i));
      tracks[i].anomaly = scorer.score(summaries[i], tracks[i].novelty ?? 0);
    } catch (_e) {
      tracks[i].anomaly = null;
    }
  }
}
