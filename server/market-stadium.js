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

router.get("/api/market/sales", (_req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=3600").json(readJson(path.join(DATA, "sales.json")));
  } catch (e) {
    res.status(503).json({ error: "sales_unavailable", detail: String(e?.message ?? e) });
  }
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
