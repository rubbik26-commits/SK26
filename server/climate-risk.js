// Climate risk — FEMA National Risk Index, served from the shipped dataset.
//
// The captured application shows licensed First Street per-property flood /
// heat / wildfire scores. The public stand-in is FEMA's National Risk Index,
// which publishes a risk score per census tract. Tract scores are rolled up to
// county and MSA by population weight so every geography level answers.
//
// Nothing here is invented: every number is read from the same places-*.json
// files the Market Stadium surface ships. A level with no NRI coverage answers
// `configured: false` with a reason rather than a fabricated score.
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "public", "market", "data");

const LEVELS = new Set(["cbsa", "county", "tract", "zipcode"]);
const cache = new Map();

function readPlaces(level) {
  if (cache.has(level)) return cache.get(level);
  const file = path.join(DATA, `places-${level}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = Array.isArray(parsed) ? parsed : parsed.places ?? [];
  cache.set(level, rows);
  return rows;
}

/** Population weight for a rollup; falls back to 1 so a null never zeroes a mean. */
function weight(row) {
  const pop = Number(row?.dem023c1);
  return Number.isFinite(pop) && pop > 0 ? pop : 1;
}

const HAZARDS = ["coastal", "flood", "heat", "wind", "quake", "fire"];

/** Population-weighted mean of one NRI field across a set of tract rows. */
function weightedMean(rows, field) {
  let sum = 0;
  let wsum = 0;
  for (const r of rows) {
    const v = r?.nri?.[field];
    if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
    const w = weight(r);
    sum += Number(v) * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : null;
}

function band(score) {
  if (score === null || score === undefined) return null;
  if (score < 20) return "Very Low";
  if (score < 40) return "Relatively Low";
  if (score < 60) return "Relatively Moderate";
  if (score < 80) return "Relatively High";
  return "Very High";
}

/** Roll tract NRI up to a parent geography. */
function rollup(tracts) {
  const out = {
    risk: weightedMean(tracts, "risk"),
    eal: weightedMean(tracts, "eal"),
    sovi: weightedMean(tracts, "sovi"),
    resl: weightedMean(tracts, "resl"),
    tracts: tracts.length,
    rolled_up: true
  };
  for (const h of HAZARDS) out[h] = weightedMean(tracts, h);
  out.rating = band(out.risk);
  return out;
}

const router = Router();

router.get("/api/climate-risk", (req, res) => {
  const level = String(req.query.level ?? "tract");
  const geoid = String(req.query.geoid ?? "").trim();

  if (!LEVELS.has(level)) {
    return res.status(400).json({ error: "unknown_level", level, allowed: [...LEVELS] });
  }
  if (!geoid) {
    return res.status(400).json({ error: "bad_request", detail: "geoid is required" });
  }

  let rows;
  try {
    rows = readPlaces(level);
  } catch (e) {
    return res.status(503).json({
      error: "climate_dataset_unavailable",
      level,
      detail: String(e?.message ?? e)
    });
  }

  const row = rows.find((r) => String(r.geoid) === geoid);
  if (!row) {
    return res.status(404).json({ error: "place_not_found", level, geoid });
  }

  // Tract rows carry the full NRI record (risk, rating, EAL, SOVI, RESL and one
  // field per hazard), so they are returned as-is.
  if (level === "tract") {
    return res.set("Cache-Control", "public, max-age=3600").json({
      configured: true,
      level,
      geoid,
      name: row.name ?? null,
      source: "FEMA National Risk Index (tract)",
      nri: row.nri ?? null
    });
  }

  // County/MSA rows carry a PARTIAL precomputed rollup (risk/sovi/resl only, and
  // no rating or hazard fields), so it is never returned directly: the tract
  // layer is rolled up here instead, which yields the rating band and every
  // hazard. ZIP rows have no tract rollup key at all and answer configured:false.

  let tracts;
  try {
    tracts = readPlaces("tract");
  } catch (e) {
    return res.status(503).json({
      error: "climate_dataset_unavailable",
      level: "tract",
      detail: String(e?.message ?? e)
    });
  }

  // The tract layer stores `county` as a bare 3-digit code ("061") and `state`
  // separately, while a county GEOID is the 5-digit state+county FIPS
  // ("36061"). Joining on `county` alone therefore matched nothing. CBSA is a
  // 5-digit code on both sides and joins directly.
  let children;
  if (level === "cbsa") {
    children = tracts.filter((t) => String(t.cbsa) === geoid);
  } else if (level === "county") {
    const stateFips = geoid.slice(0, 2);
    const countyFips = geoid.slice(2).padStart(3, "0");
    children = tracts.filter(
      (t) => String(t.state) === stateFips && String(t.county).padStart(3, "0") === countyFips
    );
  } else {
    return res.json({
      configured: false,
      level,
      geoid,
      name: row.name ?? null,
      reason: "The National Risk Index publishes at census-tract level only; this geography has no tract rollup key."
    });
  }
  if (!children.length) {
    return res.json({
      configured: false,
      level,
      geoid,
      name: row.name ?? null,
      reason: "No tract in the shipped dataset maps to this geography."
    });
  }

  return res.set("Cache-Control", "public, max-age=3600").json({
    configured: true,
    level,
    geoid,
    name: row.name ?? null,
    source: "FEMA National Risk Index (tract, population-weighted rollup)",
    nri: rollup(children)
  });
});

export default router;
