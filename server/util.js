// Deterministic PRNG + shared helpers. Every synthetic record in the demo data
// engine is seeded from a stable key (bbl, zip, tile id) so the same lot looks
// identical across every endpoint, refresh, and restart.

export function seedFromString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(key) {
  return mulberry32(seedFromString(String(key)));
}

export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

export function pickSome(rng, arr, max, min = 0) {
  const n = Math.max(min, Math.floor(rng() * (max + 1)));
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  }
  return out;
}

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const round = (n, d = 0) => {
  const p = 10 ** d;
  return Math.round(n * p) / p;
};

// Web-mercator tile helpers ---------------------------------------------------
export function tileToLngLat(x, y, z) {
  const n = 2 ** z;
  const lng = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lng, lat };
}

export function lngLatToTile(lat, lng, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

// Earth radius 3958.8 miles, in feet — measured, not chosen.
//
// Every distanceFt the original publishes on /api/nearby was solved for the
// radius that reproduces it: for each observation the feasible interval is
// [(ft - 0.5) / u, (ft + 0.5) / u] where u is the unit-radius central angle.
// Intersecting 216 observations across ten probe points (Midtown, Staten
// Island, FiDi, Bed-Stuy, South Bronx, East Village, Crown Heights, Astoria,
// Bay Ridge, Jamaica) leaves a single consistent window with no contradictions:
//
//   20,902,400.85 .. 20,902,647.03 ft   (6,371,051.6 .. 6,371,126.6 m)
//
// 3958.8 mi = 20,902,464 ft sits inside it and reproduces 216/216. The 6371 km
// sphere this used (20,902,231 ft) is just below the window and reproduced
// 214/216 — it published 286 ft where the original publishes 287 (BBL
// 1005460035) and 148 where the original publishes 149 (BBL 3018680055),
// because both raw values land at x.4988 and the original's radius carries
// them over the half.
export function haversineFt(lat1, lng1, lat2, lng2) {
  const R = 3958.8 * 5280; // earth radius in feet
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function bearingDeg(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}
