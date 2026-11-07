// Production owner for /api/opportunities.
//
// Mounted at server.js ahead of routes-bundle, production-live-extra and
// routes, each of which also declares this path and is therefore shadowed.
//
// SELECTION, measured against https://nycremarketintel.com on 2026-08-19 by
// reproducing its published feeds from live Socrata PLUTO (64uk-42ks) and
// comparing BBL sequences position by position:
//
//   bare / empty filters / unknown assetClass with no ZIP
//     lotarea >= 225793 and latitude IS NOT NULL, government owners removed,
//     ordered assesstot DESC, first 150.
//     -> 150/150 in the original's exact order.
//     A top-N-by-lotarea pool was ruled out: top-200/300/400/500/1000 by
//     lotarea then assesstot DESC missed 150/150/143/130/76 respectively.
//
//   ?zips=Z (no assetClass)
//     zipcode in (Z) and latitude IS NOT NULL, no lot floor, same denylist,
//     assesstot DESC, first 150.  -> 11216: 0 missing, 0 extra.
//
//   ?zips=Z&assetClass=multifamily
//     + (bldgclass like 'C%' or bldgclass like 'D%') and lotarea >= 2101.
//     -> 11216: 0 missing, 0 extra. The floor is real and was bracketed:
//     lotarea >= 2100 left 1 wrong, >= 2000 left 3, >= 0 left 4.
//
//   ?zips=Z&assetClass=office|condo|hotels
//     + the class predicate, NO lot floor.
//     -> 10001 office 150/150, condo 85/85, hotels 57/57, all exact order.
//     A 2101 floor was ruled out here: it drops 3 of the original's condos.
//
//   ?zips=Z&assetClass=development
//     + bldgclass like 'V%' ONLY, no lot floor, then ordered opportunityScore
//     DESC. -> 10001: 29/29 set-identical. Including Z% was ruled out: it adds
//     3 lots the original does not serve.
//
//   ?neighborhood= NEVER filters. Measured: ?neighborhood=Chelsea / Hudson
//   Yards returns the same 150 BBLs in the same order as bare with only the
//   neighborhood string changed on all 150 items. The parameter is echoed into
//   every item; absent, it echoes "FiDi / Lower Manhattan", which is the only
//   value the bare feed carries. This route previously derived the value from
//   the DCP NTA layer and then FILTERED on it, which is why the same BBL came
//   back as "Chelsea / Hudson Yards" where the original says "FiDi / Lower
//   Manhattan".
//
// The certified-PostGIS shortcut this route used to try first is gone: the
// contract above is reproduced from live PLUTO exactly, and the store's own
// status is fresh=false / no_complete_ingest_certificate, so it could only
// answer with a different universe than the one measured.
//
// The authored/demo seed universe is never returned by this route.
import { Router } from "express";
import { soql } from "./adapters/socrata.js";
import { DS } from "./adapters/nyc.js";
import { plutoRowsToParcels } from "./opps-live.js";

const router = Router();

// The same government-owner denylist server/area-buildings.js applies. Measured
// as the only rule separating the original's kept rows from its dropped ones:
// selection by ownertype was ruled out — kept rows include ownertype C
// (CITIFIELD, BROOKLYN NAVY YARD DEV) and X (NATIONAL PARK SERVICE x4) while a
// dropped row is X (UNITED STATES OF AMERICA).
const GOV_RE = /\bCITY OF\b|\bNYC\b|NEW YORK CITY|STATE OF NEW ?YORK|\bNY STATE\b|\bNYS\b|UNITED STATES|\bFEDERAL\b|DEPARTMENT OF|DEPT OF|\bDEPT\b|\bAUTHORITY\b|\bAUTH\b|DORMITORY|METROPOLITAN TRANS|\bMTA\b|\bTRANSIT\b|PORT AUTH|HOUSING AUTH|\bNYCHA\b|TRIBOROUGH|\bRAILROAD\b|\bAMTRAK\b|CON ?ED|CONSOLIDATED EDISON|NATIONAL GRID|BOARD OF ED|PUBLIC LIBRARY|POST OFFICE|\bSANITATION\b|ECONOMIC DEVELOPMENT|\bEDC\b|PUBLIC SCHOOL|\bU\.?S\.?A\.?\b/;

const CLASS_PRED = {
  multifamily: "(bldgclass like 'C%' or bldgclass like 'D%')",
  condo: "bldgclass like 'R%'",
  office: "bldgclass like 'O%'",
  hotels: "bldgclass like 'H%'",
  development: "bldgclass like 'V%'"
};
// The same five predicates as CLASS_PRED, applied in JS. A ZIP feed's class
// narrowing happens AFTER the lot-area pool below, so it cannot be part of the
// pull's WHERE without changing which rows the pool holds. `like 'C%'` never
// matches a NULL bldgclass and neither does /^[CD]/ against "".
const CLASS_RE = {
  multifamily: /^[CD]/,
  condo: /^R/,
  office: /^O/,
  hotels: /^H/,
  development: /^V/
};
const CITYWIDE_LOT_FLOOR = 225793;
// NOT APPLIED, and kept only because it is the measurement that disproved
// itself. It was derived from ?zips=11216&assetClass=multifamily, where a
// 2101 lot floor reproduces the original exactly (0 missing / 0 extra) and
// 2100 leaves 1 wrong, 2000 leaves 3, no floor leaves 4. It is a coincidence
// of that one ZIP. On ?zips=10001&assetClass=multifamily the same floor is
// 14/150 wrong and NO floor is exact:
//   floor 2101 -> missing 14 extra 14   (drops 132 WEST 26 STREET, lot 1,852 sf,
//                                        assesstot 3,249,900 — the original's
//                                        83rd row — and back-fills from below)
//   no floor   -> missing  0 extra  0
// What actually separates 11216's four rows is the lot-area POOL described at
// ZIP_POOL_LIMIT, which subsumes this floor: with the pool in place, 11216
// multifamily is exact with no lot floor at all.
const MULTIFAMILY_LOT_FLOOR = 2101;
// A ZIP feed is answered from that ZIP's 1,500 largest lots, not from the whole
// ZIP. The class predicate, the government denylist and the assesstot ordering
// all apply to that pool, which is why they can never reach a small lot in a
// ZIP that has more than 1,500 lots.
//
// MEASURED, from the original's own rows. For each ZIP+lens the eligibility
// threshold L is bracketed by (largest lot the original refuses, smallest lot
// the original publishes], then converted to a row count over that ZIP's lots
// ordered lotarea DESC:
//   ?zips=11207&assetClass=multifamily  L in (3150, 3285]  => N in [1495, 1550]
//   ?zips=11216&assetClass=multifamily  L in (2100, 2500]  => N in [1401, 2014]
//   ?zips=11226&assetClass=multifamily  L in (3800, 4921]  => N in [1397, 1786]
//   ?zips=11216&assetClass=condo        L in (2300, 2400]  => N in [1514, 1586]
//   ?zips=11216&assetClass=development  L in (2200, 2500]  => N in [1401, 1727]
//   ?zips=11207 (no class)              L in (2375, 4317]  => N in [1056, 4473]
// 11207 is the binding pair and 1500 is the only round number inside it. The
// intervals that appear to exclude it (11221's, 11216 condo's) are ZIPs whose
// boundary falls inside a large equal-lotarea group — 11221 has 758 lots at
// exactly 2,500 sf — where a `$limit` cut splits the group in an order Socrata
// picks, so the whole-group arithmetic above overstates the bound.
//
// Without the pool the ZIP feeds are wrong by a wide margin, e.g.
//   ?zips=11207&assetClass=multifamily  36 of 150 rows wrong
//   ?zips=11216&assetClass=condo        rebuild served 150 rows, original 84
const ZIP_POOL_LIMIT = 1500;
const RESULT_LIMIT = 150;
// The pool is read past the denylist so it cannot starve the 150. Ordering is
// stable, so a longer prefix yields the same first 150 survivors as the 400-row
// prefix the reproduction was verified with.
const POOL_LIMIT = 1000;
const DEFAULT_NEIGHBORHOOD = "FiDi / Lower Manhattan";
const OWNER_OF_RECORD_FALLBACK = "Owner of record (PLUTO)";

const OPP_SELECT = [
  "bbl", "address", "latitude", "longitude", "block", "lot", "zonedist1", "landuse",
  "lotarea", "bldgarea", "builtfar", "residfar", "commfar", "facilfar", "yearbuilt",
  "numfloors", "ownername", "zipcode", "bldgclass", "assesstot"
].join(",");

function zipsFrom(v) {
  return [...new Set(String(v || "").split(",").map((x) => x.trim()).filter((x) => /^\d{5}$/.test(x)))];
}

const isGovernmentOwner = (name) => GOV_RE.test(String(name ?? "").toUpperCase());

// The published order of a lot whose assesstot is NULL. Socrata sorts NULL
// FIRST under `DESC`, so the pull hands them back at the head; the original
// publishes them at the BOTTOM, ranked with the zeroes and immediately AHEAD of
// a lot whose assesstot is literally 0.
//
// Where the rebuild put them (before this comparator existed):
//   ?zips=11109  whole universe, 11 rows, nothing hidden by the 150 prefix
//     original [0] LIVE-4000210020 45-45 CENTER BOULEVARD  assesstot 129,888,000
//              [10] LIVE-4000210065 "—"                    assesstot NULL
//     rebuild  [0] LIVE-4000210065 "—"                     <- NULL first
//              [1] LIVE-4000210020 45-45 CENTER BOULEVARD
//   ?zips=10001  the same defect one row wide — the rebuild published
//     LIVE-1008360057 (no bldgclass, no address, no assesstot) at [0] and
//     pushed the original's 150th row, LIVE-1007800019 225 WEST 30 STREET,
//     off the tail.  MISSING ["LIVE-1007800019"] EXTRA ["LIVE-1008360057"].
//
// NULL ranks ahead of a literal 0 rather than after it. ?zips=10004 is the only
// ZIP in the city that publishes a NULL-assesstot lot and a 0-assesstot lot
// that both clear the government denylist and both fit the served window (118
// PLUTO rows -> 105 published). Five consecutive runs against each side, 1.5 s
// apart, identical every time — so this is not the recorded equal-assesstot tie
// nondeterminism, which does move between runs:
//   run0..run4 O-tail: … LIVE-1000030004(69) LIVE-1000110028(NULL) LIVE-1000080044(0)
//   run0..run4 R-tail: … LIVE-1000030004(69) LIVE-1000080044(0) LIVE-1000110028(NULL)
// A plain `assesstot DESC NULL LAST` on the pull was tried and ruled out by
// that measurement: it orders those two the wrong way round.
//
// Array.prototype.sort is stable, so every other pair — including the equal
// assesstot ties that come back nondeterministically from Socrata on both
// sides — keeps the order the pull returned.
const assessRank = (row) => {
  const n = Number(row?.assesstot);
  return Number.isFinite(n) ? n : 0;
};
const assessIsNull = (row) => !Number.isFinite(Number(row?.assesstot));
function byPublishedRank(a, b) {
  const d = assessRank(b) - assessRank(a);
  if (d !== 0) return d;
  // Only ever reached with two rows of rank 0, i.e. a NULL against a literal 0.
  return (assessIsNull(a) ? 0 : 1) - (assessIsNull(b) ? 0 : 1);
}

// The original's item: exactly 33 keys, in this order, and nothing else.
// Measured on its bare feed. This route additionally published zip, assetClass,
// scoreValueType and scoreBasis, none of which the original has.
function opportunityContract(p, neighborhood) {
  return {
    id: p.id,
    address: p.address,
    neighborhood,
    category: p.category,
    lat: p.lat,
    lng: p.lng,
    bbl: p.bbl,
    bin: p.bin,
    block: p.block,
    lot: p.lot,
    zoning: p.zoning,
    landUse: p.landUse,
    lotSf: p.lotSf,
    bldgSf: p.bldgSf,
    far: p.far,
    maxFar: p.maxFar,
    yearBuilt: p.yearBuilt,
    floors: p.floors,
    // PLUTO leaves ownername off 389 lots citywide. The original publishes the
    // literal string "Owner of record (PLUTO)" for those, not an empty string.
    // Measured on all three ZIPs whose universe is small enough to publish such
    // a lot (the string appears nowhere in the compiled bundle, so it is the
    // original's own server-side fallback):
    //   ?zips=11109 [10] LIVE-4000210065  O "Owner of record (PLUTO)"  R ""
    //   ?zips=11697 [12] LIVE-4163500101  O "Owner of record (PLUTO)"  R ""
    //   ?zips=10004 [103] LIVE-1000110028 O "Owner of record (PLUTO)"  R ""
    // Applied here rather than in server/opps-live.js:211 (`owner: r.ownername
    // ?? ""`) because that mapper is shared with server/routes-bundle.js and
    // this measurement covers only /api/opportunities.
    owner: p.owner || OWNER_OF_RECORD_FALLBACK,
    ownerNote: p.ownerNote,
    opportunityScore: p.opportunityScore,
    conversionFit: p.conversionFit,
    risk: p.risk,
    status: p.status,
    signals: p.signals,
    policyCatalysts: p.policyCatalysts,
    adaptiveReuse: p.adaptiveReuse,
    thesis: p.thesis,
    riskFlags: p.riskFlags,
    nextAction: p.nextAction,
    estLandPpbsf: p.estLandPpbsf,
    unbuiltFarSf: p.unbuiltFarSf,
    sourcedFact: p.sourcedFact
  };
}

router.get("/api/opportunities", async (req, res) => {
  const zipList = zipsFrom(req.query.zips);
  const assetClass = String(req.query.assetClass || "");
  const neighborhood = String(req.query.neighborhood || "") || DEFAULT_NEIGHBORHOOD;
  // A value outside the five known classes is ignored, exactly as the original
  // ignores it: ?zips=&assetClass=misc is byte-identical to the bare feed.
  const wantClass = Object.prototype.hasOwnProperty.call(CLASS_PRED, assetClass) ? assetClass : "";

  const where = [];
  if (zipList.length) {
    // No class predicate and no lot floor here: a ZIP feed's pool is the ZIP's
    // 1,500 largest lots regardless of lens, and the lens narrows that pool
    // afterwards. Putting either in the WHERE changes which lots the pool
    // holds. See ZIP_POOL_LIMIT and MULTIFAMILY_LOT_FLOOR above.
    where.push(`zipcode in (${zipList.map((z) => `'${z}'`).join(",")})`);
  } else {
    where.push(`lotarea >= ${CITYWIDE_LOT_FLOOR}`);
    if (wantClass) where.push(CLASS_PRED[wantClass]);
  }
  where.push("latitude IS NOT NULL");

  const r = await soql(DS.pluto, {
    $select: OPP_SELECT,
    $where: where.join(" and "),
    // Two different cuts, because the original makes two different cuts.
    //
    // The citywide feed is already narrowed to its 2,009 largest lots by
    // CITYWIDE_LOT_FLOOR, so it is pulled straight in published order. Socrata's
    // default for `DESC` puts a NULL assesstot FIRST — measured on 11109,
    // `$order=assesstot DESC` returns 4000210065:NULL ahead of
    // 4000210020:129888000 — and that placement is kept deliberately: it is
    // what guarantees the handful of assessment-less lots sit inside the
    // POOL_LIMIT prefix at all. Where they belong in the PUBLISHED order is
    // decided by byPublishedRank() below, not here.
    //
    // A ZIP feed is narrowed by the pull itself: the ZIP's 1,500 largest lots.
    // See ZIP_POOL_LIMIT for the measurement that fixes 1,500.
    ...(zipList.length
      ? { $order: "lotarea DESC", $limit: ZIP_POOL_LIMIT }
      : { $order: "assesstot DESC", $limit: POOL_LIMIT })
  }).catch((e) => ({ live: false, rows: [], error: e?.message }));

  if (!r?.live) {
    return res.status(503).json({
      provenance: "unavailable",
      error: r?.error || "pluto_unavailable"
    });
  }

  // The lens narrows the pool, not the pull, on a ZIP feed. On the citywide
  // feed CLASS_PRED already did it in the WHERE and this is a no-op.
  const pooled = zipList.length && wantClass
    ? (r.rows || []).filter((row) => CLASS_RE[wantClass].test(String(row.bldgclass ?? "")))
    : (r.rows || []);
  const kept = pooled.filter((row) => !isGovernmentOwner(row.ownername)).sort(byPublishedRank).slice(0, RESULT_LIMIT);
  // The position each surviving row held in the PULL, before byPublishedRank
  // imposed the assessment order. The development re-sort below needs it: a
  // full tie there falls back to this order, not to the assessment order.
  const arrivalOf = new Map(pooled.map((row, i) => [row, i]));
  const parcels = plutoRowsToParcels(kept);
  const parcelArrival = new Map(parcels.map((parcel, i) => [parcel, arrivalOf.get(kept[i])]));
  // Development is the one lens the original re-orders: its items come back
  // strictly opportunityScore DESC while every other lens stays in the pull's
  // assesstot DESC order.
  //
  // WITHIN a tied score the original orders by LOT AREA, descending — i.e. it
  // keeps the ZIP pull's own order rather than the assesstot rank that
  // byPublishedRank imposed above. Measured 2026-08-20 on the original's own
  // rows; every tie group is monotonically lotarea DESC:
  //
  //   10001  score 93   10,897  9,875  7,357
  //   10001  score 90    4,937  2,765  2,666  2,624  2,470  2,469  2,368
  //   10001  score 87    2,176    996    890
  //   11216  score 89    4,167  3,820  3,400  3,270  3,116  2,898  2,700  2,560
  //   11216  score 87    2,694  2,500  2,500  2,500
  //
  // Their assesstot runs in no order at all inside those groups (11216 score 89:
  // 26,280 / 34,740 / 208,935 / 214,200 / 140,400 / 192,600 / 169,650 / 217,800),
  // so the sort that produced them cannot be the assessment rank.
  // A FULL tie — equal score AND equal lot area — keeps the pull's own order,
  // not the assessment order byPublishedRank imposed. Measured 2026-08-20 on
  // ?zips=11216&assetClass=development: rows 15-17 are a three-way tie (score
  // 87, lotSf 2,500, unbuiltFarSf 5,000). The original publishes them
  // 3018220032, 3019680041, 3018120065 — exactly the order five consecutive
  // direct pulls of the ZIP pool ($order=lotarea DESC) returned them, stable
  // every time — while this handler published 3019680041, 3018120065,
  // 3018220032, which is their assesstot DESC order left over from
  // byPublishedRank. Array.prototype.sort is stable, so restoring the arrival
  // order as the explicit final key is exact, not heuristic.
  if (wantClass === "development") {
    parcels.sort((a, b) =>
      ((b.opportunityScore ?? 0) - (a.opportunityScore ?? 0)) ||
      ((Number(b.lotSf) || 0) - (Number(a.lotSf) || 0)) ||
      ((parcelArrival.get(a) ?? 0) - (parcelArrival.get(b) ?? 0)));
  }

  // Exact endpoint contract: bare array. Do not wrap with provenance metadata.
  return res.json(parcels.map((p) => opportunityContract(p, neighborhood)));
});

export default router;
