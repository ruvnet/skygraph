// Route enrichment: adsbdb callsign lookup, fetched only when an aircraft
// is selected (never bulk — one keyless API call per new callsign per day).
//
// Source survey (probed 2026-06-10 with a real request,
// Origin: http://localhost:8000):
//   GET api.adsbdb.com/v0/callsign/ACA123
//     -> 200, access-control-allow-origin: *  (usable from the browser)
//   GET api.adsbdb.com/v0/callsign/ZZZ9X9
//     -> 404 {"response":"unknown callsign"}  (cached as a miss)
//
// Hits and misses cache in localStorage for 24 h; network/CORS errors are
// not cached so a flaky connection can retry on the next selection.

const CACHE_KEY = "skygraph-routes-v1";
const TTL_MS = 24 * 3600e3;
const MAX_CACHE = 300;
const FETCH_TIMEOUT_MS = 6000;

const pending = new Map(); // callsign -> in-flight promise

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); }
  catch (_e) { return {}; }
}

function saveCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE) {
    keys.sort((a, b) => cache[a].at - cache[b].at)
      .slice(0, keys.length - MAX_CACHE)
      .forEach((k) => delete cache[k]);
  }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_e) { /* quota */ }
}

function pick(body) {
  const fr = body?.response?.flightroute;
  if (!fr) return null;
  const ap = (a) => a ? { iata: a.iata_code || "", name: a.municipality || a.name || "" } : null;
  return {
    airline: fr.airline?.name || null,
    origin: ap(fr.origin),
    destination: ap(fr.destination),
  };
}

// Resolve {airline, origin, destination} | null (no route known) for a
// callsign. Never rejects — resolves null on any failure.
export async function routeFor(callsign) {
  const cs = String(callsign || "").trim().toUpperCase();
  if (!cs) return null;
  const cache = loadCache();
  const hit = cache[cs];
  if (hit && Date.now() - hit.at < TTL_MS) return hit.route;
  if (pending.has(cs)) return pending.get(cs);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  const p = fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`,
    { signal: ctl.signal, headers: { Accept: "application/json" } })
    .then((r) => {
      if (r.status === 404) return null;        // unknown callsign — cache the miss
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json().then(pick);
    })
    .then((route) => {
      const c = loadCache();
      c[cs] = { at: Date.now(), route };
      saveCache(c);
      return route;
    })
    .catch(() => null) // network/CORS — graceful skip, not cached
    .finally(() => { clearTimeout(timer); pending.delete(cs); });
  pending.set(cs, p);
  return p;
}

// Display lines for the details panel.
export function routeLines(route) {
  if (!route) return ["route: not in adsbdb"];
  const lines = [];
  if (route.airline) lines.push(`airline: ${route.airline}`);
  if (route.origin && route.destination) {
    lines.push(`route: ${route.origin.iata} ${route.origin.name} → ` +
      `${route.destination.iata} ${route.destination.name}`);
  }
  return lines.length ? lines : ["route: not in adsbdb"];
}
