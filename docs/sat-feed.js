// RuView SkyGraph satellite layer data: TLE fetch + cache, per CelesTrak
// group.
//
// Source survey (probed 2026-06-10 with Origin: http://localhost:8000):
//   celestrak.org gp.php?GROUP=visual&FORMAT=tle -> 200, ACAO: *   PRIMARY
//
// Groups offered in the ⚙ drawer:
//   visual   (~160 brightest objects — default, Canvas2D-friendly)
//   stations (crewed stations + visitors, a couple dozen)
//   starlink (~7 000+ — only offered while the WebGPU sat layer is active;
//             "active" would be bigger still and is deliberately not offered)
//
// TLEs change slowly, so responses cache in localStorage for 6 h per group
// to stay polite to CelesTrak. Propagation happens in sky-monitor-wasm
// (`SatPropagator`, SGP4) — without the wasm pkg the satellite layer simply
// stays off.

export const TLE_GROUPS = ["visual", "stations", "starlink"];
const TLE_URL = (g) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(g)}&FORMAT=tle`;
const CACHE_KEY = (g) => `skygraph-tle-${g}-v1`;
const TLE_TTL_MS = 6 * 3600e3;
const FETCH_TIMEOUT_MS = 15000;

// Parse 3-line TLE text (name / line 1 / line 2) into [{name, l1, l2}].
export function parseTle(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);
  const sats = [];
  let i = 0;
  while (i + 2 < lines.length + 1) {
    if (lines[i + 1]?.startsWith("1 ") && lines[i + 2]?.startsWith("2 ")) {
      sats.push({ name: lines[i].trim(), l1: lines[i + 1], l2: lines[i + 2] });
      i += 3;
    } else {
      i += 1;
    }
  }
  return sats;
}

// Load TLEs for a group: fresh cache -> network -> stale cache. Returns
// `{sats, source}` or null when no TLEs are available at all.
export async function loadTles(group = "visual") {
  if (!TLE_GROUPS.includes(group)) group = "visual";
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY(group)) || "null");
  } catch (_e) { /* corrupt cache — refetch */ }
  if (cached?.sats?.length && Date.now() - cached.at < TLE_TTL_MS) {
    return { sats: cached.sats, source: `cache (${group})` };
  }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(TLE_URL(group), { signal: ctl.signal })
      .finally(() => clearTimeout(timer));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const sats = parseTle(await r.text());
    if (!sats.length) throw new Error("no TLEs in response");
    try {
      localStorage.setItem(CACHE_KEY(group), JSON.stringify({ at: Date.now(), sats }));
    } catch (_e) { /* quota (starlink is ~2 MB) — run uncached */ }
    return { sats, source: `celestrak ${group}` };
  } catch (_e) {
    if (cached?.sats?.length) return { sats: cached.sats, source: `stale cache (${group})` };
    return null;
  }
}
