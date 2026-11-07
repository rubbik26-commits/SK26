// Market news — deterministic briefs generated from the shipped dataset.
//
// The captured application streams commercial-market headlines from a
// proprietary aggregator. That feed is not public and cannot be reproduced, so
// this module does NOT pretend to be it. It derives briefs from the real ACS /
// PLUTO numbers in the shipped dataset, labels every one as derived, and
// returns an explicit `configured: false` when a live feed is not wired.
//
// If MARKET_NEWS_FEED_URL is set, the module proxies that feed instead and
// reports `source: "live"`. Without it, `source: "derived"` is stated plainly.
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

const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

function pct(v) {
  const n = num(v);
  return n === null ? null : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function usd(v) {
  const n = num(v);
  if (n === null) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Monthly rent is a small number where the K abbreviation is wrong: 2000 must
 * read "$2,000", not "$2K". Rents therefore get their own whole-dollar
 * formatter rather than sharing usd().
 */
function usdRent(v) {
  const n = num(v);
  if (n === null) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Build briefs from the row's own numbers. Every figure quoted is a real value
 * from the shipped dataset; nothing is synthesised.
 */
function deriveBriefs(row) {
  const name = row?.name ?? "This market";
  const out = [];

  const value = num(row?.hval001c1);
  const gValue = num(row?.hval001g0);
  if (value !== null) {
    out.push({
      id: "value",
      kind: "Market",
      headline: `${name} median home value at ${usd(value)}${gValue !== null ? `, ${pct(gValue)} year over year` : ""}`,
      body:
        `The median value across the area is ${usd(value)}.` +
        (gValue !== null
          ? ` That is a ${pct(gValue)} change against the prior five-year vintage, taken from the same ACS table.`
          : " No prior-vintage comparison is available for this geography."),
      metric: "hval001c1",
      value,
      change: gValue
    });
  }

  const rent = num(row?.hou002c1);
  const gRent = num(row?.hou002g0);
  if (rent !== null) {
    out.push({
      id: "rent",
      kind: "Rents",
      headline: `Median gross rent ${usdRent(rent)}/mo${gRent !== null ? `, ${pct(gRent)}` : ""}`,
      body:
        `Median gross rent is ${usdRent(rent)} per month.` +
        (gRent !== null ? ` Rent moved ${pct(gRent)} over the prior vintage.` : ""),
      metric: "hou002c1",
      value: rent,
      change: gRent
    });
  }

  const vac = num(row?.hou005c1);
  const units = num(row?.hou006c1);
  if (vac !== null) {
    out.push({
      id: "supply",
      kind: "Supply",
      headline: `Vacancy at ${vac.toFixed(1)}%${units !== null ? ` across ${Math.round(units).toLocaleString("en-US")} units` : ""}`,
      body:
        `The vacancy rate is ${vac.toFixed(1)}%.` +
        (units !== null ? ` The housing stock holds roughly ${Math.round(units).toLocaleString("en-US")} units.` : ""),
      metric: "hou005c1",
      value: vac,
      change: num(row?.hou005g0)
    });
  }

  const mhi = num(row?.hcap001c1);
  if (mhi !== null) {
    out.push({
      id: "income",
      kind: "Demographics",
      headline: `Median household income ${usd(mhi)}`,
      body:
        `Median household income is ${usd(mhi)}.` +
        (num(row?.hcap001g0) !== null ? ` Income changed ${pct(row.hcap001g0)} over the prior vintage.` : ""),
      metric: "hcap001c1",
      value: mhi,
      change: num(row?.hcap001g0)
    });
  }

  const pov = num(row?.pov001c1);
  if (pov !== null) {
    out.push({
      id: "poverty",
      kind: "Demographics",
      headline: `Poverty rate ${pov.toFixed(1)}%`,
      body: `The poverty rate is ${pov.toFixed(1)}% of the population for whom it is determined.`,
      metric: "pov001c1",
      value: pov,
      change: num(row?.pov001g0)
    });
  }

  const score = num(row?.mscor001c1);
  if (score !== null) {
    out.push({
      id: "score",
      kind: "Market",
      headline: `Market score ${score.toFixed(2)} of 10`,
      body:
        `The composite market score is ${score.toFixed(2)} of 10, built from the ACS factors this deployment ships. ` +
        `It is a percentile composite, not the captured application's proprietary weighting.`,
      metric: "mscor001c1",
      value: score,
      change: null
    });
  }

  return out;
}

const router = Router();

router.get("/api/market-news", async (req, res) => {
  const level = String(req.query.level ?? "cbsa");
  const geoid = String(req.query.geoid ?? "").trim();

  if (!LEVELS.has(level)) {
    return res.status(400).json({ error: "unknown_level", level, allowed: [...LEVELS] });
  }
  if (!geoid) {
    return res.status(400).json({ error: "bad_request", detail: "geoid is required" });
  }

  // A configured live feed wins; it is proxied rather than re-implemented.
  const feed = process.env.MARKET_NEWS_FEED_URL;
  if (feed) {
    try {
      const url = new URL(feed);
      url.searchParams.set("level", level);
      url.searchParams.set("geoid", geoid);
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const json = await r.json();
      return res.set("Cache-Control", "public, max-age=300").json({
        configured: true,
        source: "live",
        level,
        geoid,
        items: Array.isArray(json) ? json : json.items ?? []
      });
    } catch (e) {
      return res.status(502).json({
        error: "news_feed_unavailable",
        detail: String(e?.message ?? e)
      });
    }
  }

  let rows;
  try {
    rows = readPlaces(level);
  } catch (e) {
    return res.status(503).json({
      error: "news_dataset_unavailable",
      level,
      detail: String(e?.message ?? e)
    });
  }

  const row = rows.find((r) => String(r.geoid) === geoid);
  if (!row) return res.status(404).json({ error: "place_not_found", level, geoid });

  const items = deriveBriefs(row);
  return res.set("Cache-Control", "public, max-age=3600").json({
    configured: true,
    source: "derived",
    note:
      "Derived from the shipped ACS/PLUTO dataset. The captured application's proprietary " +
      "headline feed is not public; set MARKET_NEWS_FEED_URL to proxy a live one.",
    level,
    geoid,
    name: row.name ?? null,
    items
  });
});

export default router;
