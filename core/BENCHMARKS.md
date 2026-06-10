# sky-monitor benchmarks and validation

Criterion results for the ADR-199 SkyGraph appliance example
(`cargo bench -p sky-monitor`), plus the mapping from the integration
test suite to the ADR-199 acceptance criteria.

## Environment

| | |
|---|---|
| CPU | Intel(R) Xeon(R) Processor @ 2.80 GHz (4 cores, virtualized CI container) |
| rustc | 1.94.1 |
| harness | criterion (workspace version), `--release` |
| scenario | deterministic synthetic day: 10 aircraft, 2,820 observations, seed 42 |

Numbers below are criterion midpoints. The container is shared, so
treat ±5% as noise.

## Results

| Benchmark | Baseline | After tuning | Delta |
|---|---|---|---|
| `coords/observer_frame_single` (WGS-84 → az/el/range/bearing) | 149.0 ns | 131.5 ns | **−12%** |
| `coords/observer_frame_batch/10k_targets` | 1.458 ms (~146 ns/target) | 1.291 ms (~129 ns/target) | **−10%** (criterion-confirmed, p < 0.05) |
| `embedding/track_embedding` (32-dim, ~280-point track) | 21.77 µs | 20.83 µs | −4% |
| `ruvector/insert_1000_then_search` (VectorDB, euclidean flat) | 4.23 ms | 4.51 ms | noise (untouched code) |
| `anomaly/score_track_full` (full §15 composite) | 151.6 µs | 161.8 µs | see note |
| `pipeline/end_to_end_standard_scenario` | 6.57 ms | 7.17 ms | see note |

### Optimizations applied

- **`coords::observer_frame`** — inlined the
  `geodetic_to_ecef → ecef_to_enu → initial_bearing_deg` composition so
  each `sin`/`cos` is computed exactly once via `sin_cos()` (the helper
  composition recomputed observer trig three times and target trig
  twice). The public helpers are unchanged and the geometry unit tests
  pin the math.
- **`embedding::track_embedding`** — single pass over the point series
  accumulating all per-point statistics at once, instead of one full
  iteration per feature (~14 walks) plus a temporary `Vec` of
  altitudes.

### Note on the anomaly/pipeline rows

Between the two runs, the anomaly module gained the `TrackSummary`
adapter (`BaselineStats::from_summaries` / `score_summary`) so the
**native and WASM scorers share one exact code path** (the
`sky-monitor-wasm` `AnomalyScorer` calls the same scorer the appliance
uses). The ~10 µs/track delta is the cost of that indirection plus run
noise; it was accepted deliberately — scoring parity between the
appliance and the browser dashboard is worth more than 10 µs on a path
that runs once per completed track.

## Real-time headroom (ADR-199 §22 Phase 1 acceptance: aircraft visible within 5 s of decode)

| Budget | Measured | Headroom at 1 Hz update |
|---|---|---|
| Projection per aircraft | ~129 ns | ~7.7 M projections/s/core → tens of thousands of aircraft trivially; a busy sky (500 aircraft) costs ~65 µs/frame |
| Track embedding | ~21 µs per completed track | embeddings are per-track, not per-frame |
| RuVector index, 1,000 tracks | 4.5 ms to insert 1,000 + search | similarity/novelty queries run per completed track, far below 1 Hz budget |
| Anomaly composite score | ~162 µs per track | ~6,000 tracks/s sustainable |
| Whole synthetic day (ingest → tracks → index → score → graph → brief) | ~7 ms | a full day of data replays ~12,000,000× faster than real time |

Conclusion: on appliance-class hardware (Pi 5 is slower than this Xeon
but same order), the pipeline is **not** compute-bound; the binding
constraints are radio reception and storage, exactly as ADR-199 §26
anticipates.

## ADR-199 acceptance mapping (`tests/acceptance.rs`, 8/8 passing)

| Test | Proves (ADR-199 §31 / §22) |
|---|---|
| `acceptance_1_positions_convert_to_az_el_range` | §31.2 — positions convert to azimuth/elevation/range (§22 Phase 1: azimuth within 10°) |
| `acceptance_2_overhead_query_excludes_en_route` | §31.6 — "what flew overhead" returns the low pass, not 10 km cruisers (§14 rule 1) |
| `acceptance_3_aircraft_by_time_window` | §31.5/§22 Phase 3 — SkyGraph query returns aircraft by time window |
| `acceptance_4_anomaly_scoring_separates_corridor_traffic` | §31.8/§22 Phase 4 — anomalous track ≥ 0.76 alert threshold, corridor traffic ≤ 0.55 with baseline history |
| `acceptance_5_explain_cites_observation_ids` | §31.9/§27 rule 1 — explanations cite underlying observation ids |
| `acceptance_6_similarity_prefers_same_corridor` | §22 Phase 4 — RuVector similar-track search returns plausible prior matches |
| `acceptance_7_brief_renders_with_counts` | §31.7 — daily sky brief renders with non-zero counts |
| `acceptance_8_dump1090_parser` | §31.1 path — dump1090 `aircraft.json` parses into the canonical pipeline |

Plus 19 unit tests (geometry, schema round-trip, stitching, embeddings,
scoring bands, graph queries) and 5 native tests in `sky-monitor-wasm`
(polar screen mapping). Full suite: **32/32 green**, `clippy` clean for
both crates, `wasm32-unknown-unknown` builds clean (debug + release).

## WASM functional verification

`wasm-pack build --target web` produces a 150 KB `sky_monitor_wasm_bg.wasm`
(with `wasm-opt = false`; smaller with binaryen available). The module was
exercised end-to-end in Node against a `--target nodejs` build:

- projection: observer at Oakville, target 10 km due north at 1,000 m →
  azimuth 0.00°, elevation 5.10°, range 10,029 m (matches native `coords`)
- screen mapping: zenith → canvas center, below-horizon invisible
- `project_batch`: `[lat,lon,alt]×N → [az,el,range,bearing]×N` shape verified
- anomaly parity: with an 8-track corridor baseline, the low off-corridor
  night track scores **0.900 (strong anomaly)** with cited reasons while a
  corridor flight scores 0.055 (normal) — identical code path to the native
  scorer via `TrackSummary`
- `parse_dump1090_json` parses a live-format `aircraft.json` payload

## Recommendations not applied (file-ownership / scope)

- `pipeline.rs` re-stitches tracks once per baseline pass; caching the
  stitched tracks between the baseline split and scoring would shave
  ~1 ms off the end-to-end run. Low value at current scale.
- The flat (non-HNSW) VectorDB index is fine for ≤10⁴ tracks; switching
  the indexer to the HNSW index in `ruvector-core` is the right move
  when local history exceeds that (ADR-199 §18.4 retention makes this
  unlikely for a single observer).

Reproduce with:

```bash
cargo bench -p sky-monitor                 # full criterion suite
cargo bench -p sky-monitor -- --test       # fast smoke mode
```
