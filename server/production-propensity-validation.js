// One authoritative propensity-validation implementation for both the Deal Radar
// banner and the analytics/backtest endpoint. The base parcel cohort is the same
// 500-lot area sample used by the production scorer; recorded sales are paged to
// completion instead of silently stopping at 1,500/5,000 rows.
//
// PUBLISHED CONTRACT — measured against the specification
// (https://nycremarketintel.com, owner gate cookie, 2026-08-19). The original
// publishes SIX keys in this exact order and nothing else:
//
//   GET /api/propensity-validation?zips=10001
//   {"soldCount":42,"soldHitPct":14,"baseCount":500,"baseHitPct":14,"lift":1,"threshold":35}
//   GET /api/propensity-validation?zips=11216
//   {"soldCount":162,"soldHitPct":4,"baseCount":500,"baseHitPct":6,"lift":0.67,"threshold":35}
//
// This rebuild used to publish thirteen keys — `provenance`, `soldScoredCount`,
// `salesRowsExamined`, `salesComplete`, `pointInTime`, `methodology` and `note`
// on top of the six, and with `provenance`/`threshold` hoisted to the front:
//   {"provenance":"live","threshold":35,"soldCount":352,"soldScoredCount":13,
//    "soldHitPct":0,"baseCount":500,"baseHitPct":9,"lift":0,
//    "salesRowsExamined":363,"salesComplete":true,"pointInTime":false,
//    "methodology":"...","note":"..."}
// Seven keys the original does not publish, in the wrong order. Every one of
// those measurements is still computed below and carried on the internal
// `diagnostic` object — nothing was deleted; it is simply no longer published,
// because the specification does not publish it.
import { Router } from "express";
import { areaBuildings, PROPENSITY_THRESHOLD } from "./area-buildings.js";
import { DS } from "./adapters/nyc.js";
import { soql, escSoql } from "./adapters/socrata.js";

const router = Router();
const SALES_PAGE = 5000;
const SALES_MAX = 50000;

// The original withholds `lift` until at least ten lots have been recorded as
// sold, no matter how healthy the rest of the measurement looks. Bracketed
// exactly on the specification 2026-08-19 by composing ZIP sets whose single-ZIP
// soldCounts are known (10039 -> 5, 10004 -> 3, 10005 -> 1, 10044 -> 2, 10006 -> 3):
//   ?zips=10039,10004,10005  soldCount=9  baseHitPct=12  lift=null
//   ?zips=10039,10004,10044  soldCount=10 baseHitPct=12  lift=0
//   ?zips=10004,10044,10005,10006 soldCount=9 baseHitPct=13 lift=null
//   ?zips=10039,10004,10006  soldCount=11 baseHitPct=12  lift=0
// A single sold lot that scored Elevated is NOT enough on the original either:
//   ?zips=11697  soldCount=1 soldHitPct=100 baseHitPct=20 lift=null
// so the withholding is driven by the sold sample size, not by the ratio.
const LIFT_MIN_SOLD_COUNT = 10;

const zipsFrom = (v) => [...new Set(String(v ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d{5}$/.test(x)))];

// The original reads ONLY ?zips= (measured: ?zip=10001 answers
// 400 {"error":"Provide ?zips="} there, while /api/area-buildings accepts both),
// splits it on commas, trims, and drops empty tokens. It applies no 5-digit
// validation of its own — a token that is not a ZIP is handed straight to the
// two upstream queries and simply matches nothing.
const zipTokensFrom = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// The original's zero state, measured 2026-08-19 for ?zips=abc, ?zips=1234,
// ?zips=abc,def, ?zips=11216.0 and ?zips=99999 — all 200, all this body:
//   {"soldCount":0,"soldHitPct":0,"baseCount":0,"baseHitPct":0,"lift":null,"threshold":35}
const zeroEnvelope = () => ({
  soldCount: 0,
  soldHitPct: 0,
  baseCount: 0,
  baseHitPct: 0,
  lift: null,
  threshold: PROPENSITY_THRESHOLD
});

async function completeRollingSales(zips, since) {
  const rows = [];
  const where = `zip_code in (${zips.map((z) => `'${escSoql(z)}'`).join(",")}) and sale_date > '${since}T00:00:00.000'`;
  for (let offset = 0; offset < SALES_MAX; offset += SALES_PAGE) {
    const r = await soql(DS.rollingSales, {
      $where: where,
      $select: "borough,block,lot,sale_date,sale_price",
      $order: "sale_date DESC,borough,block,lot",
      $limit: SALES_PAGE,
      $offset: offset
    }, { timeoutMs: 30000, ttlMs: 30 * 60 * 1000 });
    if (!r.live) return { live: false, rows: [], error: r.error || "rolling_sales_unavailable" };
    const page = r.rows || [];
    rows.push(...page);
    if (page.length < SALES_PAGE) return { live: true, rows, complete: true };
  }
  return {
    live: false,
    rows: [],
    error: `rolling_sales_exceeded_${SALES_MAX}_row_safety_ceiling`
  };
}

async function measure(query) {
  // ?zips= contract, measured on the specification 2026-08-19:
  //   (absent)      -> 400 {"error":"Provide ?zips="}
  //   ?zips=        -> 400 {"error":"Provide ?zips="}
  //   ?zips=,,      -> 400 {"error":"Provide ?zips="}
  //   ?zips=%20     -> 400 {"error":"Provide ?zips="}
  //   ?zip=10001    -> 400 {"error":"Provide ?zips="}   (the singular is not read)
  //   ?zips=abc     -> 200 zero envelope (NOT 400)
  // The rebuild answered 400 {"error":"zips_required"} for every one of these,
  // so both the status class for unusable-but-present tokens and the error body
  // itself were wrong.
  const tokens = zipTokensFrom(query.zips);
  if (!tokens.length) return { status: 400, body: { error: "Provide ?zips=" } };

  const zips = zipsFrom(tokens.join(","));
  if (!zips.length) return { status: 200, body: zeroEnvelope() };

  // areaBuildings already requires both PLUTO count/detail calls and computes
  // propensity from actual DOB permit counts. If permit history is unavailable,
  // it returns rows whose scores omit that signal; a validation must not compare
  // those partial scores to sales as though the evidence set were complete.
  const area = await areaBuildings({
    zips: zips.join(","),
    page: 0,
    pageSize: 500,
    sort: "lotarea"
  });
  if (area.status !== 200 || !area.body) {
    return { status: area.status || 503, body: area.body || { provenance: "unavailable", error: "area_unavailable" } };
  }
  const permitSource = (area.body.sources || []).find((s) => s.id === "dob_permits_area");
  if (permitSource?.status === "error") {
    return {
      status: 503,
      body: {
        provenance: "unavailable",
        error: "dob_permits_unavailable",
        note: "Validation is not calculated with unknown permit history treated as zero activity."
      }
    };
  }

  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const sales = await completeRollingSales(zips, since);
  if (!sales.live) {
    return { status: 503, body: { provenance: "unavailable", error: sales.error || "rolling_sales_unavailable" } };
  }

  const buildings = area.body.buildings || [];
  const byBbl = new Map(buildings.map((b) => [b.bbl, Number(b.propensity) || 0]));
  const soldBbls = new Set();
  for (const r of sales.rows) {
    const borough = String(r.borough ?? "").trim();
    const block = String(r.block ?? "").trim();
    const lot = String(r.lot ?? "").trim();
    if (!borough || !block || !lot) continue;
    soldBbls.add(borough + block.padStart(5, "0") + lot.padStart(4, "0"));
  }

  // WHAT soldCount COUNTS IS NOT RECOVERED, and this records the search rather
  // than shipping a fitted constant. Measured 2026-08-20 on eight ZIPs across
  // four boroughs, original vs this build:
  //
  //   zip     original  this build   distinct sold BBLs that exist in PLUTO
  //   10001         41         203   41 at a $250k floor   <- exact
  //   10451         31          66   31 at a $250k floor   <- exact
  //   11434        292         502  292 at a $250k floor   <- exact
  //   11101         92         516   89
  //   11216        161         351  157 at $250k, 170 unfiltered
  //   10002         45         228   46
  //   11215        232         888  282
  //   10314        294        1034  476
  //
  // The join to PLUTO is clearly right — it drops the condo-unit BBLs that have
  // no lot of their own — and a $250,000 floor lands three ZIPs exactly. But no
  // single rule reaches all eight. Swept offline over the cached pulls: window
  // lengths 335-390 days, window END dates 0-120 days back, price floors 0 /
  // 1 / 100k / 150k / 200k / 250k / 300k, and five join targets (every PLUTO
  // lot, lots with a building class, lots with residential units, the 500 and
  // the 2,000 largest by lot area) — roughly 250 combinations. The best scored
  // 3 of 8, and two ZIPs are unreachable in principle: 11216's target of 161
  // EXCEEDS its 157 candidates at that floor, while 10314's 294 is far below
  // its 476, so one rule cannot move both the right way.
  //
  // That pattern — a target above the candidate pool on one ZIP and far below
  // it on another — is what a snapshot taken at a different moment looks like,
  // and this endpoint's siblings on the original are all cached (the maturity
  // wall is frozen at April recordings, listingcheck and listing-check replay
  // stored payloads). I do not know the exact cause of this yet.
  //
  // What DOES match and is not disturbed here: the six-key envelope and its key
  // order, baseCount 500, threshold 35, the 400 body "Provide ?zips=", the
  // null-lift rule below ten sold lots, and the lift rounding.
  const soldScored = [...soldBbls].filter((bbl) => byBbl.has(bbl));
  const pct = (hit, total) => total > 0 ? Math.round((hit / total) * 100) : 0;
  const soldCount = soldBbls.size;
  const soldHitPct = pct(soldScored.filter((bbl) => byBbl.get(bbl) >= PROPENSITY_THRESHOLD).length, soldScored.length);
  const baseCount = buildings.length;
  const baseHitPct = pct(buildings.filter((b) => (Number(b.propensity) || 0) >= PROPENSITY_THRESHOLD).length, baseCount);
  // Ratio and rounding confirmed against the specification 2026-08-19:
  //   ?zips=11040  soldHitPct 13 / baseHitPct 1  -> lift 13
  //   ?zips=10075  soldHitPct  1 / baseHitPct 11 -> lift 0.09
  //   ?zips=10306  soldHitPct  1 / baseHitPct  5 -> lift 0.2
  //   ?zips=10314  soldHitPct  0 / baseHitPct  1 -> lift 0    (zero, not null)
  //   ?zips=11375  soldHitPct  7 / baseHitPct  0 -> lift null (no base rate)
  const lift = (soldCount >= LIFT_MIN_SOLD_COUNT && baseHitPct > 0)
    ? Math.round((soldHitPct / baseHitPct) * 100) / 100
    : null;

  // Everything the original does not publish is still measured here. It is kept
  // off the response body — not deleted — because the specification's envelope
  // carries six keys and an extra key is a defect. `salesComplete` in particular
  // records that completeRollingSales() paged the recorded-sales set to the end
  // rather than stopping at a page boundary.
  const diagnostic = {
    provenance: "live",
    soldScoredCount: soldScored.length,
    salesRowsExamined: sales.rows.length,
    salesComplete: true,
    pointInTime: false,
    methodology: "trailing-12mo-recorded-sales-vs-current-scores",
    note: "Recorded DOF Rolling Sales are paged to completion for the requested ZIPs and matched against propensity scores computed from current PLUTO plus live DOB permit activity. PLUTO is a current snapshot, not a historical point-in-time archive."
  };

  return {
    status: 200,
    // Key order is the specification's, byte for byte:
    // soldCount, soldHitPct, baseCount, baseHitPct, lift, threshold.
    body: {
      soldCount,
      soldHitPct,
      baseCount,
      baseHitPct,
      lift,
      threshold: PROPENSITY_THRESHOLD
    },
    diagnostic
  };
}

router.get("/api/propensity-validation", async (req, res) => {
  try {
    const out = await measure(req.query);
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(503).json({ provenance: "unavailable", error: "propensity_validation_unavailable", message: e?.message || "Validation failed." });
  }
});

// The specification does not publish /api/analytics/backtest at all. Measured
// 2026-08-19 with the owner gate cookie:
//   GET /api/analytics/backtest              -> 404 {"error":"Not found"}
//   GET /api/analytics/backtest?zips=11216   -> 404 {"error":"Not found"}
//   GET /api/analytics/backtest?zips=10001   -> 404 {"error":"Not found"}
// which is the same body its unknown-API handler returns for any path it does
// not serve (GET /api/nonexistent-endpoint-xyz -> 404 {"error":"Not found"}).
// The rebuild answered 200 with the full validation envelope here, and 400 with
// no ?zips=.
//
// The route stays registered on purpose. server/production-analytics.js:171
// also defines /api/analytics/backtest and is mounted after this router
// (server.js:180 vs server.js:214), so removing this handler would not produce
// the original's 404 — it would hand the path to that router's 200/503 instead.
// Keeping it here and answering with the measured 404 is what makes the rebuild
// behave like the specification. measure() is unchanged and still shared with
// the Deal Radar path above, so the measurement itself is not lost.
router.get("/api/analytics/backtest", async (req, res) => {
  res.status(404).json({ error: "Not found" });
});

export { measure as completePropensityValidation };
export default router;
