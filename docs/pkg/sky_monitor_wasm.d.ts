/* tslint:disable */
/* eslint-disable */

/**
 * §15 anomaly scorer over track summaries, sharing the exact native scoring
 * path (`BaselineStats::from_summaries` + `score_summary`).
 *
 * `Default` gives the ADR-199 §15 weights (`AnomalyConfig::default()`) and
 * an empty baseline.
 */
export class AnomalyScorer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Build the baseline from an array of track summaries:
     * `[{icao24, callsign, mean_alt_m, dominant_heading_deg, start_hour,
     *    mean_signal_dbfs, min_range_m, max_elevation_deg}, ...]`.
     * Returns the number of baseline tracks ingested.
     */
    baseline_from(tracks_json: any): number;
    /**
     * Number of tracks in the current baseline.
     */
    baseline_len(): number;
    /**
     * New scorer with the ADR-199 §15 default weights and an empty baseline.
     */
    constructor();
    /**
     * Score one track summary against the baseline; `novelty` in `[0, 1]`
     * (vector novelty from the native indexer, or 0 when unavailable).
     * Returns `{score, band, reasons}`.
     */
    score(track_json: any, novelty: number): any;
}

/**
 * SGP4 propagator over a set of TLEs, projecting each satellite into a fixed
 * observer's sky (same §10 observer frame as aircraft).
 */
export class SatPropagator {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add one TLE; returns `false` (and skips it) on parse/init failure.
     */
    add_tle(name: string, line1: string, line2: string): boolean;
    /**
     * Number of loaded satellites.
     */
    count(): number;
    /**
     * Name of satellite `i` (insertion order, as passed to `add_tle`).
     */
    name(i: number): string;
    /**
     * New propagator for the observer's geodetic position.
     */
    constructor(lat: number, lon: number, alt_m: number);
    /**
     * Propagate every satellite to Unix time `unix_s` and project it into
     * the observer's sky. Returns a `Float64Array` of
     * `[lat_deg, lon_deg, alt_m, azimuth_deg, elevation_deg, range_m]` per
     * satellite (insertion order); a satellite that fails to propagate
     * (e.g. decayed) yields six `NaN`s.
     */
    positions(unix_s: number): Float64Array;
    /**
     * Predict horizon-to-horizon passes for every loaded satellite,
     * stepping SGP4 from `start_unix` over `hours` in `step_s`-second
     * samples (use ~30 s; rise/set instants are linearly interpolated
     * between samples).
     *
     * Returns a `Float64Array` of 7-tuples, one per pass:
     * `[sat_index, t_rise, t_culminate, t_set, max_elevation_deg,
     *   culmination_azimuth_deg, visible]`. `visible` is `1.0` when the
     * satellite is sunlit against a dark observer sky (sun below −6°) at
     * any sampled point of the pass — the same naked-eye criterion the
     * dashboard's astro.js applies to the live layer. A pass still in
     * progress at the window end is truncated there; satellites that fail
     * to propagate (e.g. decayed) simply yield no passes.
     */
    predict_passes(start_unix: number, hours: number, step_s: number): Float64Array;
}

/**
 * Fixed observer projecting WGS-84 targets into its local sky
 * (ADR-199 §10: geodetic → ECEF → ENU → azimuth/elevation/range/bearing).
 */
export class SkyProjector {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * New projector at the observer's geodetic position.
     */
    constructor(lat: number, lon: number, alt_m: number);
    /**
     * Project one target; returns `{range_m, azimuth_deg, elevation_deg,
     * bearing_deg}`.
     */
    project(lat: number, lon: number, alt_m: number): any;
    /**
     * Batched projection for trail rendering: input is a `Float64Array` of
     * `[lat, lon, alt_m]` triplets; output is a `Float64Array` of
     * `[azimuth_deg, elevation_deg, range_m, bearing_deg]` quadruplets, one
     * per input triplet (a trailing partial triplet is ignored).
     */
    project_batch(coords: Float64Array): Float64Array;
    /**
     * Map an az/el direction onto a `width`×`height` canvas using the polar
     * "fisheye" all-sky projection: zenith (el = 90°) at the canvas centre,
     * horizon (el = 0°) on the inscribed-circle edge, azimuth 0° = North =
     * straight up. Returns `{x, y, visible}` (`visible` = above horizon).
     */
    screen_position(azimuth_deg: number, elevation_deg: number, width: number, height: number): any;
}

/**
 * ADR-199 §15 interpretation band for a composite score:
 * `normal | mildly unusual | interesting | strong anomaly | rare`.
 */
export function band_for(score: number): string;

/**
 * Embed one live track: `points` is a `Float64Array` of
 * `[t_unix, lat, lon, alt_m, azimuth_deg, elevation_deg, range_m]` per
 * sample (time-ordered), `rssi_dbfs` the track's receiver signal (use −20
 * when the feed carries none). Returns the 32-dim §13 embedding
 * (`Float32Array`), every dimension normalized to `[0, 1]`.
 */
export function embed_track(points: Float64Array, rssi_dbfs: number): Float32Array;

/**
 * §15 `novelty_score` of `query` against `past` — a flattened
 * `Float32Array` of concatenated 32-dim prior embeddings. Mirrors
 * `TrackIndexer::novelty_score`: mean euclidean distance to the top-3
 * nearest priors, divided by the 1.2 calibration constant, clamped to 1;
 * neutral 0.5 when no priors exist.
 */
export function novelty(query: Float32Array, past: Float32Array): number;

/**
 * Parse a dump1090-style `aircraft.json` payload (live RTL-SDR feed) into an
 * array of aircraft state objects, using the same core parser as the native
 * pipeline. Entries without a position fix are skipped.
 */
export function parse_dump1090_json(json: string): any;

/**
 * Crate version (for the dashboard footer / cache busting).
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_anomalyscorer_free: (a: number, b: number) => void;
    readonly __wbg_satpropagator_free: (a: number, b: number) => void;
    readonly __wbg_skyprojector_free: (a: number, b: number) => void;
    readonly anomalyscorer_baseline_from: (a: number, b: number, c: number) => void;
    readonly anomalyscorer_baseline_len: (a: number) => number;
    readonly anomalyscorer_new: () => number;
    readonly anomalyscorer_score: (a: number, b: number, c: number, d: number) => void;
    readonly band_for: (a: number, b: number) => void;
    readonly embed_track: (a: number, b: number, c: number, d: number) => void;
    readonly novelty: (a: number, b: number, c: number, d: number) => number;
    readonly parse_dump1090_json: (a: number, b: number, c: number) => void;
    readonly satpropagator_add_tle: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly satpropagator_count: (a: number) => number;
    readonly satpropagator_name: (a: number, b: number, c: number) => void;
    readonly satpropagator_new: (a: number, b: number, c: number) => number;
    readonly satpropagator_positions: (a: number, b: number, c: number) => void;
    readonly satpropagator_predict_passes: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly skyprojector_new: (a: number, b: number, c: number) => number;
    readonly skyprojector_project: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly skyprojector_project_batch: (a: number, b: number, c: number, d: number) => void;
    readonly skyprojector_screen_position: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly version: (a: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
