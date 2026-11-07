// Market Stadium — national market-intelligence API.
//
// Serves the ACS/TIGER dataset built by the Market Stadium ETL (the same
// files the standalone replica ships) under /api/market/*, so the Market
// Stadium surface mounted at /market/ can read it from this server instead
// of from its own static tree. Read-only, no auth beyond the site gate, and
// no fabricated values: a missing file is a 503 with an explicit reason.
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "public", "market", "data");
const GEO = path.join(__dirname, "..", "public", "market", "geo");

const LEVELS = new Set(["cbsa", "county", "tract", "zipcode"]);
const cache = new Map();

function readJson(file) {
  if (cache.has(file)) return cache.get(file);
  const body = fs.readFileSync(file, "utf8");
  const json = JSON.parse(body);
  cache.set(file, json);
  return json;
}

const router = Router();

router.get("/api/market/meta", (_req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=3600").json(readJson(path.join(DATA, "meta.json")));
  } catch (e) {
    res.status(503).json({ error: "market_dataset_unavailable", detail: String(e?.message ?? e) });
  }
});

router.get("/api/market/places/:level", (req, res) => {
  const level = String(req.params.level);
  if (!LEVELS.has(level)) return res.status(404).json({ error: "unknown_level", level });
  try {
    res.set("Cache-Control", "public, max-age=3600")
      .json(readJson(path.join(DATA, `places-${level}.json`)));
  } catch (e) {
    res.status(503).json({ error: "market_dataset_unavailable", level, detail: String(e?.message ?? e) });
  }
});

router.get("/api/market/geo/:level", (req, res) => {
  const level = String(req.params.level);
  if (!LEVELS.has(level)) return res.status(404).json({ error: "unknown_level", level });
  try {
    res.set("Cache-Control", "public, max-age=3600")
      .json(readJson(path.join(GEO, `${level}.geojson`)));
  } catch (e) {
    res.status(503).json({ error: "market_geometry_unavailable", level, detail: String(e?.message ?? e) });
  }
});

router.get("/api/market/pluto", (_req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=3600").json(readJson(path.join(DATA, "pluto.json")));
  } catch (e) {
    res.status(503).json({ error: "pluto_unavailable", detail: String(e?.message ?? e) });
  }
});

// Recorded sales. The shipped file is { sales: [...] }; `zip` and `limit`
// filter it without changing the response shape, so a caller that ignores the
// params still gets the whole file.
router.get("/api/market/sales", (req, res) => {
  let file;
  try {
    file = readJson(path.join(DATA, "sales.json"));
  } catch (e) {
    return res.status(503).json({ error: "sales_unavailable", detail: String(e?.message ?? e) });
  }
  const all = Array.isArray(file) ? file : Array.isArray(file?.sales) ? file.sales : [];
  const zip = String(req.query.zip ?? "").trim();
  const filtered = zip ? all.filter((r) => String(r.zip ?? "") === zip) : all;
  const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const rows = Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered;

  res.set("Cache-Control", "public, max-age=3600").json({
    sales: rows,
    total: all.length,
    filtered: filtered.length,
    zip: zip || null
  });
});

// Address search. The Census geocoder sends no CORS header, so the browser
// cannot call it directly; this proxies the lookup and returns only the
// geography identifiers the UI needs to select a place.
router.get("/api/market/geocode", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.status(400).json({ error: "bad_query", detail: "q is required" });
  if (q.length > 200) return res.status(400).json({ error: "bad_query", detail: "q is too long" });

  const url =
    "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress" +
    `?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return res.status(502).json({ error: "geocoder_unavailable", detail: `upstream ${r.status}` });
    const json = await r.json();
    const match = json?.result?.addressMatches?.[0];
    if (!match) return res.json({ matched: false, query: q });

    const g = match.geographies ?? {};
    const pick = (k) => (Array.isArray(g[k]) && g[k][0]) || null;
    const tract = pick("Census Tracts");
    const county = pick("Counties");
    const zcta = pick("2020 Census ZIP Code Tabulation Areas");
    const cbsa = pick("Metropolitan Statistical Areas") ?? pick("Combined Statistical Areas");

    res.json({
      matched: true,
      query: q,
      matchedAddress: match.matchedAddress,
      coordinates: match.coordinates,
      tract: tract ? { geoid: tract.GEOID, name: tract.NAME } : null,
      county: county ? { geoid: county.GEOID, name: county.NAME } : null,
      zipcode: zcta ? { geoid: zcta.GEOID, name: zcta.NAME } : null,
      cbsa: cbsa ? { geoid: cbsa.GEOID, name: cbsa.NAME } : null
    });
  } catch (e) {
    res.status(502).json({
      error: "geocoder_unavailable",
      detail: e?.name === "TimeoutError" ? "Census geocoder timed out" : String(e?.message ?? e)
    });
  }
});

// ---------------------------------------------------------------------------
// Record / ranking / macro reads.
//
// The Market Stadium surface reads its dataset from its own static tree, but
// the lucia shell layer (public/js/market-stadium/ms-territory.js) reads the
// same dataset through this API. These three routes are the contract that
// layer calls; without them the Territory Mastery attachment renders an error
// box instead of market context.
//
// Scoring is the surface's own documented rule, not a new one:
//   composite = weighted mean of the 11 category scores (meta.categoryWeights)
//   tier      = 11 - ceil(score), clamped to 1..10   (theme/tokens.ts)
// Category scores are the mean of their member factors' percentile scores
// (sc_<code>), which the ETL already computed within each level.
// ---------------------------------------------------------------------------

const LEVEL_ALIASES = { city: "cbsa", metro: "cbsa", msa: "cbsa", zip: "zipcode", zcta: "zipcode" };
const normalizeLevel = (raw) => {
  const key = String(raw ?? "").toLowerCase();
  return LEVEL_ALIASES[key] ?? key;
};

function placesFor(level) {
  const rows = readJson(path.join(DATA, `places-${level}.json`));
  return Array.isArray(rows) ? rows : [];
}

/** Weighted mean of the 11 category scores, using the dataset's own weights. */
function compositeScore(place, weights) {
  const cats = place?.cats;
  if (!cats || typeof cats !== "object") return null;
  let sum = 0;
  let total = 0;
  for (const [name, value] of Object.entries(cats)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const w = typeof weights?.[name] === "number" ? weights[name] : 1;
    sum += value * w;
    total += w;
  }
  return total > 0 ? sum / total : null;
}

/** tier = 11 - ceil(score), clamped 1..10 — the surface's own legend rule. */
function tierFromScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return Math.max(1, Math.min(10, 11 - Math.ceil(score)));
}

function metaWeights() {
  try {
    return readJson(path.join(DATA, "meta.json"))?.categoryWeights ?? null;
  } catch {
    return null;
  }
}

/** One geography's record: raw factors, category scores, composite and tier. */
router.get("/api/market/record/:level/:geoid", (req, res) => {
  const level = normalizeLevel(req.params.level);
  if (!LEVELS.has(level)) return res.status(404).json({ error: "unknown_level", level: req.params.level });
  const geoid = String(req.params.geoid);
  let rows;
  try {
    rows = placesFor(level);
  } catch (e) {
    return res.status(503).json({ error: "market_dataset_unavailable", level, detail: String(e?.message ?? e) });
  }
  const place = rows.find((r) => String(r.geoid) === geoid);
  if (!place) return res.status(404).json({ error: "not_found", level, geoid });

  const weights = metaWeights();
  const score = compositeScore(place, weights);
  res.set("Cache-Control", "public, max-age=3600").json({
    level,
    geoid: place.geoid,
    record: place,
    scores: { c: score, g: null, f: null },
    tiers: { c: tierFromScore(score), g: null, f: null },
    model: "weighted mean of category scores (meta.categoryWeights); tier = 11 - ceil(score)"
  });
});

/** Ranked rows for a level. `sort` is a factor code, or `c` for the composite. */
router.get("/api/market/records/:level", (req, res) => {
  const level = normalizeLevel(req.params.level);
  if (!LEVELS.has(level)) return res.status(404).json({ error: "unknown_level", level: req.params.level });
  const sort = String(req.query.sort ?? "c");
  const limit = Math.max(1, Math.min(500, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50));
  let rows;
  try {
    rows = placesFor(level);
  } catch (e) {
    return res.status(503).json({ error: "market_dataset_unavailable", level, detail: String(e?.message ?? e) });
  }

  const weights = metaWeights();
  const key = sort === "c" ? "mscor001c1" : sort;
  const scored = rows
    .map((r) => {
      const composite = typeof r.mscor001c1 === "number" ? r.mscor001c1 : compositeScore(r, weights);
      return { r, composite };
    })
    .filter((x) => typeof x.r[key] === "number" || (key === "c" && typeof x.composite === "number"));

  scored.sort((a, b) => {
    const av = key === "c" ? a.composite : a.r[key];
    const bv = key === "c" ? b.composite : b.r[key];
    return (bv ?? -Infinity) - (av ?? -Infinity);
  });

  const results = scored.slice(0, limit).map(({ r, composite }, i) => ({
    rank: i + 1,
    geoid: r.geoid,
    name: r.name,
    state: r.state ?? null,
    county: r.county ?? null,
    score_c: composite,
    tier_c: tierFromScore(composite),
    value: key === "c" ? composite : r[key]
  }));

  res.set("Cache-Control", "public, max-age=3600").json({
    level,
    sort: key,
    total: scored.length,
    count: results.length,
    results
  });
});

/** Macro series (FRED), latest value first — the dataset's own meta.macro. */
router.get("/api/market/macro", (_req, res) => {
  let meta;
  try {
    meta = readJson(path.join(DATA, "meta.json"));
  } catch (e) {
    return res.status(503).json({ error: "market_dataset_unavailable", detail: String(e?.message ?? e) });
  }
  const series = {};
  for (const s of Array.isArray(meta?.macro) ? meta.macro : []) {
    const points = Array.isArray(s.points) ? s.points : [];
    const latest = points.length ? points[points.length - 1] : null;
    const prior = points.length > 1 ? points[points.length - 2] : null;
    series[s.id] = {
      id: s.id,
      label: s.label,
      unit: s.unit,
      freq: s.freq,
      latest,
      prior,
      change: latest && prior ? latest.value - prior.value : null,
      points: points.length
    };
  }
  res.set("Cache-Control", "public, max-age=3600").json({
    source: meta?.source ?? null,
    generated: meta?.generated ?? null,
    series
  });
});

// Posture card: what this deployment is actually serving, and which inputs are
// proxies for the licensed feeds the captured application used.
router.get("/api/market/status", (_req, res) => {
  // The place and boundary files are bare arrays; the NYC record files are
  // wrapped ({ parcels: [...] }, { sales: [...] }). Count either shape.
  const count = (file) => {
    try {
      const v = readJson(file);
      if (Array.isArray(v)) return v.length;
      if (Array.isArray(v?.features)) return v.features.length;
      for (const key of ["parcels", "sales", "records", "items"]) {
        if (Array.isArray(v?.[key])) return v[key].length;
      }
      return 0;
    } catch {
      return 0;
    }
  };
  let meta = null;
  try {
    meta = readJson(path.join(DATA, "meta.json"));
  } catch {
    /* dataset absent — reported as configured:false below */
  }
  const levels = {};
  for (const level of LEVELS) {
    levels[level] = {
      places: count(path.join(DATA, `places-${level}.json`)),
      boundaries: count(path.join(GEO, `${level}.geojson`))
    };
  }
  res.json({
    configured: !!meta,
    generated: meta?.generated ?? null,
    source: meta?.source ?? null,
    levels,
    plutoLots: count(path.join(DATA, "pluto.json")),
    recordedSales: count(path.join(DATA, "sales.json")),
    model: meta?.model ?? null,
    provenance: meta ? "live" : "unavailable"
  });
});

export default router;
