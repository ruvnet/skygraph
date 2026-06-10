// Low-precision sun & moon positions (truncated Meeus series, good to a
// fraction of a degree for the sun and ~1° for the moon — display grade) and
// the cylinder-shadow satellite illumination test. A satellite is naked-eye
// "visible now" when it is above the horizon, sunlit, and the observer's sky
// is dark (sun below -6°, civil twilight).

import { DEG, geodeticToEcef, normalizeDeg } from "./project.js";

const EARTH_R_KM = 6371.0;

function j2000Days(unixS) {
  return unixS / 86400.0 - 10957.5; // days since J2000.0 (2000-01-01 12:00 UTC)
}

function gmstDeg(unixS) {
  return normalizeDeg(280.46061837 + 360.98564736629 * j2000Days(unixS));
}

// Equatorial RA/dec (deg) -> observer az/el (deg, az 0 = North).
function raDecToAzEl(raDeg, decDeg, lat, lon, unixS) {
  const H = normalizeDeg(gmstDeg(unixS) + lon - raDeg) * DEG;
  const phi = lat * DEG, dec = decDeg * DEG;
  const el = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(
    -Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return [normalizeDeg(az / DEG), el / DEG];
}

// Sun: {az, el, dir} where dir is the ECEF unit vector toward the sun
// (via the subsolar point — for satellite shadow tests).
export function sunPosition(unixS, lat, lon) {
  const d = j2000Days(unixS);
  const L = normalizeDeg(280.460 + 0.9856474 * d);
  const g = normalizeDeg(357.528 + 0.9856003 * d) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * d) * DEG;
  const ra = normalizeDeg(
    Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / DEG);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) / DEG;
  const [az, el] = raDecToAzEl(ra, dec, lat, lon, unixS);
  let subLon = normalizeDeg(ra - gmstDeg(unixS));
  if (subLon > 180) subLon -= 360;
  const v = geodeticToEcef(dec, subLon, 0);
  const n = Math.hypot(v[0], v[1], v[2]);
  return { az, el, dir: [v[0] / n, v[1] / n, v[2] / n] };
}

// Moon: {az, el}. Topocentric parallax (~1°) ignored — display only.
export function moonPosition(unixS, lat, lon) {
  const d = j2000Days(unixS);
  const L = (218.316 + 13.176396 * d) * DEG; // mean longitude
  const M = (134.963 + 13.064993 * d) * DEG; // mean anomaly
  const F = (93.272 + 13.229350 * d) * DEG;  // argument of latitude
  const lambda = L + 6.289 * DEG * Math.sin(M);
  const beta = 5.128 * DEG * Math.sin(F);
  const eps = 23.439 * DEG;
  const ra = normalizeDeg(Math.atan2(
    Math.sin(lambda) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps),
    Math.cos(lambda)) / DEG);
  const dec = Math.asin(
    Math.sin(beta) * Math.cos(eps) +
    Math.cos(beta) * Math.sin(eps) * Math.sin(lambda)) / DEG;
  const [az, el] = raDecToAzEl(ra, dec, lat, lon, unixS);
  return { az, el };
}

// Cylinder-shadow test: is a satellite at geodetic lat/lon/alt in sunlight?
export function satSunlit(latDeg, lonDeg, altM, sunDir) {
  const e = geodeticToEcef(latDeg, lonDeg, altM);
  const p = [e[0] / 1000, e[1] / 1000, e[2] / 1000]; // km
  const dot = p[0] * sunDir[0] + p[1] * sunDir[1] + p[2] * sunDir[2];
  if (dot > 0) return true; // on the sun side of Earth
  const ox = p[0] - dot * sunDir[0];
  const oy = p[1] - dot * sunDir[1];
  const oz = p[2] - dot * sunDir[2];
  return Math.hypot(ox, oy, oz) > EARTH_R_KM; // outside the shadow cylinder
}
