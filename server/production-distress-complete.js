import { Router } from "express";
import { completeDistressEvidence } from "./adapters/distress-complete.js";
import { soql } from "./adapters/socrata.js";

const router = Router();
const bblOf = (v) => { const d = String(v ?? "").replace(/[^0-9]/g, ""); return d.length === 10 ? d : ""; };
const isOpenHpd = (v) => /open/i.test(String(v?.violationstatus ?? v?.currentstatus ?? ""));
// FOUR, not five. 1008350041 has 124 complaints spread over more than five
// types and the original publishes four; 2028450001 also publishes four.
const TOP_CATEGORIES = 4;

// The 311 dataset, the same id server/adapters/nyc.js publishes as DS.s311.
const S311 = "erm2-nwe9";
const esc = (v) => String(v ?? "").replace(/'/g, "''");
// Written exactly as server/adapters/distress-complete.js complete311ByBbl()
// writes it (line 99), so the aggregate below counts the same rows the
// paginated row pull returns and total12mo cannot disagree with topCategories.
const since311 = (monthsBack = 12) =>
  new Date(Date.now() - monthsBack * 30.4 * 864e5).toISOString().slice(0, 10);

// topCategories is NOT ranked in this process. Measured 2026-08-19 against the
// original on the twenty probed BBLs that publish a threeOneOne block: the
// original delegates the whole top four to Socrata, issuing
//   erm2-nwe9.json?$select=complaint_type,count(1) as n
//     &$where=bbl='<bbl>' AND created_date > '<since>'
//     &$group=complaint_type&$order=n DESC&$limit=4
// and publishing that answer verbatim.
//
// $limit=4 is load-bearing. Socrata's order AMONG TIED COUNTS changes with the
// limit, so it is a top-N artifact and no client-side re-ranking of a full row
// pull can reproduce it. On BBL 2028450001 four types tie at n=2 behind
// UNSANITARY CONDITION:3 and the same dataset answers:
//   $limit=4   UNSANITARY CONDITION:3 | PLUMBING:2 | Noise - Residential:2 | Noise - Street/Sidewalk:2   <- what the original publishes
//   $limit=5   UNSANITARY CONDITION:3 | Sewer:2 | Noise - Residential:2 | Noise - Street/Sidewalk:2
//   $limit=10  UNSANITARY CONDITION:3 | Sewer:2 | Noise - Street/Sidewalk:2 | PLUMBING:2
//   $limit=200 UNSANITARY CONDITION:3 | Sewer:2 | Noise - Street/Sidewalk:2 | PLUMBING:2
// Both sides are deterministic — six consecutive runs of /api/distress against
// the original and six against the rebuild each produced ONE distinct ordering
// on 1000160001, 2028450001, 3002440013 and 3059880039 — so the disagreement
// was a real defect, not upstream nondeterminism.
//
// Scoreboard over the twenty lots: this query 20/20 against the original; the
// previous client-side stable sort over the row pull 10/20.
const topCategoriesFromSource = async (bbl) => {
  const params = {
    $select: "complaint_type,count(1) as n",
    $where: `bbl='${esc(bbl)}' AND created_date > '${since311()}'`,
    $group: "complaint_type",
    $order: "n DESC",
    $limit: TOP_CATEGORIES
  };
  const r = await soql(S311, params);
  if (!r.live) return { live: false, rows: [] };
  // `|| "Other"` is the same null-category convention the row-order tally below
  // uses; no probed lot exercised it.
  return {
    live: true,
    rows: (r.rows || []).map((x) => ({ type: x.complaint_type || "Other", n: Number(x.n) }))
  };
};

router.get("/api/distress", async (req, res) => {
  const bbl = bblOf(req.query.bbl);
  // Measured: GET /api/distress answers 400 {"error":"Provide a 10-digit ?bbl="}
  if (!bbl) return res.status(400).json({ error: "Provide a 10-digit ?bbl=" });
  // Ten digits with a borough digit no parcel can have is an empty result, not
  // a source outage: the original answers ?bbl=9999999999 with
  // {"hpd":null,"ecb":null,"threeOneOne":null} and a 200.
  //
  // KNOWN DIVERGENCE, measured 2026-08-19, NOT fixable from this file.
  // The original applies no borough guard at all — it queries the sources with
  // the literal ten digits and publishes whatever comes back. That is the same
  // answer as this short-circuit for every sentinel probed except one:
  //   0000000001 6000000000 7000000000 8000000000 9000000000 9999999999
  //   0123456789   original 200 {"hpd":null,"ecb":null,"threeOneOne":null}  — agrees
  //   0000000000   original 200 {"hpd":null,"ecb":null,"threeOneOne":{
  //                  "total12mo":75,"heatHotWater12mo":1,"topCategories":[
  //                  {"type":"Illegal Parking","n":15},{"type":"Blocked Driveway","n":13},
  //                  {"type":"Illegal Dumping","n":3},{"type":"Sidewalk Condition","n":3}]}}
  //                this route  200 {"hpd":null,"ecb":null,"threeOneOne":null}  — WRONG
  // 0000000000 is the BBL 311 stamps on complaints it could not geocode, so it
  // is a real key with real rows. Confirmed straight from the datasets:
  //   erm2-nwe9  bbl='0000000000' AND created_date > '<12mo>'  -> 75 rows, and
  //              $group=complaint_type&$order=n DESC&$limit=4 returns exactly the
  //              four categories the original publishes
  //   wvxf-dwi5  bbl='0000000000'                        -> 0  (so hpd null is right)
  //   855j-jady  borough='0' AND block='0' AND lot='0'   -> 0
  //   3h2n-5cm9  boro='0' AND block='0' AND lot='0'      -> 0
  //   6bgk-3dad  boro='0' AND block='0' AND lot='0'      -> 0  (so ecb null is right)
  // Deleting this line alone makes it WORSE, not better: server/adapters/nyc.js
  // parseBbl() line 87 rejects boro 0, so completeDistressEvidence() answers
  // live:false for 0000000000 (measured) and this route would then serve 503
  // where the original serves 200. Closing it needs a change in files this
  // session does not own — see the handover note in the final report. Leaving
  // the guard is the lesser divergence and it is never reached from the
  // compiled bundle, which only ever sends a BBL taken from a real record.
  if (!/^[1-5]\d{9}$/.test(bbl)) return res.json({ hpd: null, ecb: null, threeOneOne: null });

  try {
    const [evidence, topAgg] = await Promise.all([
      completeDistressEvidence(bbl),
      topCategoriesFromSource(bbl)
    ]);
    if (!evidence.live) {
      return res.status(503).json({
        provenance: "unavailable",
        error: evidence.error || "distress_sources_unavailable",
        message: "The complete official evidence set required for the distress score is unavailable. Missing or truncated sources are not treated as zero activity.",
        sourceStatus: evidence.sourceStatus || null
      });
    }

    const hpdRows = evidence.hpd.rows || [];
    const openHpd = hpdRows.filter(isOpenHpd);
    const heatOpenHpd = openHpd.filter((x) => /heat|hot water/i.test(String(x.novdescription || ""))).length;
    const { safety, legacy, ecb, sourceStatus } = evidence.dob;
    const activeSafety = safety.filter((x) => x.active);
    const activeLegacy = legacy.filter((x) => x.active);
    const activeEcb = ecb.filter((x) => x.active);

    const ecbBalance = activeEcb.reduce((sum, x) => sum + Math.max(0, x.balanceDue || 0), 0);
    const ecbBalanceAllRecords = ecb.reduce((sum, x) => sum + (x.balanceDue || 0), 0);
    const q311 = evidence.complaints.rows || [];
    const heat = q311.filter((x) => /heat|hot water/i.test(String(x.complaint_type || "")));
    const byType = new Map();
    for (const x of q311) {
      const k = x.complaint_type || "Other";
      byType.set(k, (byType.get(k) || 0) + 1);
    }

    const factors = {
      hpdOpen: Math.min(20, openHpd.length * 2),
      dobCivil: Math.min(20, (activeSafety.length + activeLegacy.length) * 2),
      ecbOpen: Math.min(20, activeEcb.length * 2),
      ecbBalance: Math.min(15, Math.floor(ecbBalance / 10000) * 3),
      complaints12mo: Math.min(15, Math.floor(q311.length / 10) * 2),
      heatHotWater12mo: Math.min(10, Math.floor(heat.length / 5) * 2)
    };
    const score = Math.min(100, Object.values(factors).reduce((s, x) => s + x, 0));

    // The envelope the original publishes, measured 2026-08-19 across six BBLs:
    // EXACTLY three keys — hpd, ecb, threeOneOne — and each of the three is
    // NULL rather than a zeroed object when it has nothing to report:
    //   1008350041  hpd null (0 HPD rows), ecb null (94 records, 0 unresolved),
    //               threeOneOne {total12mo 124, heatHotWater12mo 1, 4 categories}
    //   3011370001  hpd {open 1, total 8, heatOpen 0}, ecb {unresolved 1, balanceDue 0}
    //   2028450001  hpd {open 20, total 102, heatOpen 0}, ecb null
    //   1000160001  hpd null, ecb {unresolved 2, balanceDue 0}
    //   1012650001  all three null      9999999999  all three null
    // hpd is three keys, ecb is two, threeOneOne is three. The record lists,
    // the dob block, the distress score and its factors are not published.
    //
    // NOTE FOR THE OWNER: distressScore / distressFactors / distressValueType
    // are dropped from the response because the original does not publish them.
    // They are still computed above; nothing about the model changed. Say the
    // word and they can go back as an owner-only addition.
    // Kept, not published. This is the ranking the rebuild used to serve: a
    // stable sort by count over the 311 rows in created_date DESC, unique_key
    // ASC order. It agreed with the original on 10 of the 20 probed lots and
    // disagreed on every lot with a tie at the fourth position, which is why
    // topCategories now comes from the source aggregate above. Nothing about
    // the tally changed; it simply stopped being the published ranking.
    const topCategoriesRowOrder = [...byType].sort((a, b) => b[1] - a[1]).slice(0, TOP_CATEGORIES)
      .map(([type, count]) => ({ type, n: count }));
    // A 311 aggregate that did not answer is not four empty categories. The
    // original's behaviour on this exact query failing is not measured, so this
    // reuses the source-outage envelope this file already serves rather than
    // publishing a rank this process is not entitled to compute.
    if (q311.length && !topAgg.live) {
      return res.status(503).json({
        provenance: "unavailable",
        error: "distress_sources_unavailable",
        message: "The complete official evidence set required for the distress score is unavailable. Missing or truncated sources are not treated as zero activity.",
        sourceStatus: { threeOneOne: "unavailable" }
      });
    }
    const topCategories = topAgg.rows;
    return res.json({
      hpd: hpdRows.length ? { open: openHpd.length, total: hpdRows.length, heatOpen: heatOpenHpd } : null,
      ecb: activeEcb.length ? { unresolved: activeEcb.length, balanceDue: Math.round(ecbBalance) } : null,
      threeOneOne: q311.length
        ? { total12mo: q311.length, heatHotWater12mo: heat.length, topCategories }
        : null
    });
  } catch (e) {
    return res.status(502).json({ provenance: "unavailable", error: "distress_unavailable", message: e?.message || "Distress sources unavailable" });
  }
});

export default router;
