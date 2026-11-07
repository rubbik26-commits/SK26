// Territory Mastery + the Area Detail drill-down.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW THIS IS BUILT, AND WHY IT LOOKS NOTHING LIKE WHAT IT REPLACED
//
// The original publishes its own implementation. Every /api/territory response
// carries a `sources` array in which each entry holds the VERBATIM Socrata URL
// that produced it — dataset, $where, $select, $group, $order and $limit. Read
// on 2026-08-18 through the site gate, that is not a description of the
// endpoint, it is the endpoint. Five queries per request:
//
//   pluto_total   64uk-42ks  $where=zipcode in ('11216')
//                            $select=count(1) as n
//   pluto_census  64uk-42ks  $where=zipcode in ('11216') and <MODE PREDICATE>
//                            $select=count(1) as n[, sum(<UNIT FIELD>) as u]
//   pluto_top     64uk-42ks  $where=zipcode in ('11216') and <MODE PREDICATE>
//                            $order=<MODE ORDER>  $limit=12
//   pluto_owners  64uk-42ks  $where=zipcode in ('11216')[ and <OWNER PREDICATE>]
//                            $select=ownername, count(1) as b, sum(unitsres) as u
//                            $group=ownername  $order=b desc  $limit=60
//   rolling_sales_area  usep-8jbt
//                            $where=zip_code in ('11216') and sale_price > <MIN>
//                                   and sale_date > '<12 months ago>'
//                                   and (building_class_category like '07%' …)
//                            $select=sale_price, gross_square_feet, sale_date
//                            $limit=5000
//
// The MODE table below is those queries, one row per lens, transcribed from the
// original's own output for all six lenses. Every count it produces was checked
// against Socrata directly: 11216 → multifamily 171, condo 167, office 20,
// hotels 8, development 363, misc 3,054, all exact.
//
// A SIXTH query is not published in `sources` but is proven by the output:
// ownersByUnits is its own grouped pull ordered by units. See ownerRollup().
//
// WHAT WAS HERE BEFORE, AND WHY IT 503'd
// The previous implementation downloaded every lot in the ZIP a thousand at a
// time and then computed the census in JavaScript. It counted one universe and
// paged a different, strictly smaller one:
//
//   plutoCountByZips  →  `zipcode in(…) AND bldgclass IS NOT NULL`
//   liveAreaBuildings →  the same page, then `.filter(b => b.lat && b.lng)`
//
// and then required the second to reach the size of the first. ZIP 10001 has
// 980 lots with a building class, 11 of which MapPLUTO carries no centroid for
// (Hudson Yards air-rights and rail-yard parcels — real public records, 1,498
// of them citywide). 969 < 980, so it asked for page 1 at offset 1000, got
// nothing back, and returned
//
//   HTTP 503 {"provenance":"unavailable","error":"pluto_territory_pagination_incomplete"}
//
// where the original answers 200. It survived on 11216 only because that ZIP
// has 6,070 lots — over the 6,000 cap — so the 70-row surplus absorbed the
// losses. The gate passed by accident and failed by accident.
//
// Measured on the deployment before this change: office / hotels / condo / misc
// on 10001 all 503; the whole Territory page dead for that ZIP.
//
// There is no 6,000-lot cap here now because the original has none — it answers
// ZIP 11234 (19,382 lots) in full — and none is needed, because a count() runs
// on Socrata rather than in this process.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { soql, escSoql } from "./adapters/socrata.js";
import { DS, plutoRowToBuilding } from "./adapters/nyc.js";
import { devScoreFromReal } from "./live.js";

const router = Router();
const PLUTO = "64uk-42ks";
const ROLLING_SALES = "usep-8jbt";
const SOCRATA = "https://data.cityofnewyork.us";
const TOP_LIMIT = 12;
const OWNER_LIMIT = 60;
// The by-units rollup is the SAME grouped query with `$order=u desc`, and both
// rollups are cut to ten BEFORE they are sorted, not after. Measured 2026-08-19:
//   ZIP 11216 / condo   the original's ownersByUnits ends "USD 1370 DEAN LLC" 0,
//                       "569 ST. MARKS LLC" 0 — two groups whose sum(unitsres)
//                       is NULL, which Socrata sorts FIRST on `$order=u desc`.
//   ZIP 11234 / misc    its tenth entry is {"name":"—","buildings":7,"units":0},
//                       the NULL-ownername group, which also sorts first — while
//                       "KINGS HWY EQUITIES LLC" (85 units), the tenth-largest
//                       real holder, is NOT published.
// Sorting first and cutting to ten afterwards drops both of those zero rows and
// pulls real owners up in their place. Cutting the Socrata order to ten first
// and then sorting reproduces the original on every lens and ZIP measured.
const OWNER_UNITS_ORDER = "u desc";
const OWNER_ROWS = 10;
const DETAIL_LIMIT = 250;
const SALES_LIMIT = 5000;
// /api/area-detail?kind=sales is a different pull from the territory aggregate:
// `$order=sale_date DESC` and `$limit=500`. Measured 2026-08-19 on ZIP 10314 /
// misc, where the territory aggregate counts 587 trailing-year sales and the
// drill-down returns exactly 500, the 500 most recent (oldest published row
// 2025-10-01; every one of the 87 the rebuild had that the original did not was
// older than that). The $order is not cosmetic: it also fixes the order of rows
// that share a sale date. Socrata's natural (unordered) row order for ZIP 10001
// / condo puts "420 WEST 25 STREET, 2E" before "35 HUDSON YARDS, 5702" on
// 2026-06-17 and the original publishes them the other way round; re-running
// the same query with `$order=sale_date DESC` reproduces the original's order
// for all 103 rows exactly.
const SALES_DETAIL_LIMIT = 500;
const SALES_DETAIL_ORDER = "sale_date DESC";

// The trailing-year sale sample the territory aggregate prices from is narrower
// than the sale sample it counts. Recovered 2026-08-19 by solving 77 (ZIP, lens)
// pairs for which the original's own /api/area-detail publishes every row it
// aggregated — median AND mean have to come out right simultaneously, so each
// pair pins the thresholds from both sides:
//
//   ppsf > 10       ZIP 10028 / misc brackets this one alone: its 9.770083
//                   $/sf row must be OUT and its 10.076616 row IN.
//   ppsf < 20000    10075/misc keeps 17,675.40 $/sf; 10022/office drops
//                   21,973.20. Anything in (17675.4, 21973.2] fits; 20000 is the
//                   round number inside it.
//   sf   > 200      11365/development drops its only sale (200 land sf,
//                   6,840 $/sf — far under the ppsf ceiling, so the ceiling is
//                   not what drops it) and 11691/misc drops exactly one row of
//                   158, the 172 sf one, which is what turns its published
//                   median from an even-count 380 into the odd-count
//                   379.6046720575022 it actually serves. 10452/misc keeps a
//                   231 sf row, so the threshold is in [200, 231).
//
// All three are needed: 77 of 77 pairs reproduce with them and 46 of 77 without.
// `sales.count` and `latestSaleDate` are NOT filtered — ZIP 11216 / condo counts
// 45 sales and dates the latest 2026-06-26 while publishing medianPpsf null.
const SALES_MIN_SF = 200;
const SALES_MIN_PPSF = 10;
const SALES_MAX_PPSF = 20000;

// ZIP parsing is a scan for five-digit runs over the WHOLE parameter, not a
// per-token exact match. Measured 2026-08-19 against the original:
//   zips=11216x        → 200, zips ["11216"]        zips=x11216      → ["11216"]
//   zips=abc11216def   → ["11216"]                  zips=11216-1234  → ["11216"]
//   zips=11216.5       → ["11216"]                  zips=11216,11216 → ["11216"]
//   zips=12345 11216   → ["12345","11216"]  (one token, two ZIPs)
//   zips=112160        → 400                        zips=1121        → 400
//   zips=1234512345    → 400
// A run of six or ten digits yields nothing, so the boundaries are digit
// boundaries rather than word boundaries — `\bab11216cd\b` would not match.
// (Superseded: /^\d{5}$/ over comma-separated tokens, which 400'd five of the
// nine cases above.)
const zipsFrom = (v) => [...new Set(String(v ?? "").match(/(?<!\d)\d{5}(?!\d)/g) ?? [])];
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
// PLUTO writes nulls by OMITTING the column, and the original's row shape
// mirrors that omission key for key. See territoryRow().
const present = (r, k) => r?.[k] !== undefined && r?.[k] !== null;
// The original's placeholder for a public-record field the record does not
// carry: an em dash. Measured on `address` (BBL 4161890150 and 1000360030, both
// published as "—" with no `address` in the source row) and on the owner
// rollups (ZIP 11234's NULL-ownername group publishes as
// {"name":"—","buildings":7,"units":0}).
const EM_DASH = "—";
// Rolling Sales publishes some numeric columns with thousands separators —
// `land_square_feet` arrives as the string "10,000" — so a bare parse reads it
// as 10 and a bare Number() reads it as NaN. Both are wrong about a real
// recorded figure, so the separators come out first.
//
// This is COMPUTED but NOT PUBLISHED, because the original does not publish it.
// Measured 2026-08-19 on /api/area-detail?zips=11216&mode=development&kind=sales:
// the original serves sf 0 / ppsf null for all four vacant-land sales that carry
// comma-formatted land areas (5,900,000 / "10,000" sf; 925,000 / "1,560";
// 2,000,000 / "1,575" ×2) and medianPpsf null for the lens, which is Number()
// semantics — parseFloat would have published 10 sf and 590,000 $/sf. The
// published `sf` therefore goes through sfPublished() below; sqft() is kept
// because the stripped figure is the true one and the divergence is the
// original's, not a defect to import silently.
const sqft = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
// What the original actually publishes for a Rolling Sales area column.
const sfPublished = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Superseded 2026-08-19. This took the LOWER middle on an even count, on the
// reading that ZIP 11216's misc lens had 122 sales carrying square footage and
// reported medianPpsf 704. Re-measured against the original's own published
// sale rows across 118 (ZIP, lens) pairs, that ZIP has 121 priced sales and the
// original reports 714.2857142857143, its odd-count middle. The rule the
// original follows is below; this one is retained rather than deleted.
const medianLowerMiddleSuperseded = (a) => { const x = a.filter(Number.isFinite).sort((p, q) => p - q); return x.length ? x[Math.ceil(x.length / 2) - 1] : null; };
// The original's median: the raw middle value on an odd count, and the ROUNDED
// mean of the two middle values on an even count. Both halves are load-bearing
// and were measured together — ZIP 11216 / multifamily (31 sales) publishes
// 281.5436507936508 unrounded, while ZIP 10001 / office (8 sales) publishes 655,
// which is round((418.28265847750407 + 892.2264768206996) / 2); the lower middle
// there would be 418 and the unrounded mean 655.2545676491019.
const median = (a) => {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q);
  if (!x.length) return null;
  const mid = Math.floor(x.length / 2);
  return x.length % 2 ? x[mid] : Math.round((x[mid - 1] + x[mid]) / 2);
};
const average = (a) => { const x = a.filter(Number.isFinite); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; };
const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
// The original's window is 365 days, expressed as a bare local-style timestamp
// with no zone suffix — `sale_date > '2025-08-18T17:10:31'` on a request made
// 2026-08-18 17:10 UTC.
const salesCutoff = () => new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 19);
const PLACEHOLDER_OWNER = /^(UNAVAILABLE OWNER|NAME NOT ON FILE)$/i;
const cls = (letter) => `bldgclass like '${letter}%'`;
const NOT_TRACKED_CLASSES = `not (${["C", "D", "R", "H", "O", "V"].map(cls).join(" or ")})`;
const cat = (prefix) => `building_class_category like '${prefix}%'`;

// The six lenses, transcribed from the original's published queries.
//
// `coverage` drops its unit clause when the lens counts zero units. Measured
// 2026-08-19: ZIP 11422 / hotels (one H-class lot, sum(unitstotal) 0) serves
// "1 hotel properties across 6,880 total lots in ZIP 11422. Live from PLUTO; …"
// with no "(0 units)", and ZIP 11419 / condo does the same.
const MODES = {
  multifamily: {
    where: "unitsres >= 20",
    unitField: "unitsres",
    topOrder: "unitsres DESC",
    ownerWhere: "unitsres >= 1",
    salesMinPrice: 250000,
    salesCategories: ["07", "08", "14"],
    salesSf: "gross_square_feet",
    metric: "$/gross sf",
    detailLabel: "20+ unit buildings",
    coverage: (n, total, zip, units) =>
      `${fmt(n)} buildings with 20+ residential units across ${fmt(total)} total lots in ZIP ${zip}${units ? ` (${fmt(units)} units)` : ""}. Live from PLUTO; click any record to drill in.`
  },
  condo: {
    where: cls("R"),
    unitField: "unitsres",
    topOrder: "unitsres DESC",
    ownerWhere: cls("R"),
    salesMinPrice: 250000,
    salesCategories: ["12", "13", "15", "16", "17"],
    salesSf: "gross_square_feet",
    metric: "$/gross sf",
    detailLabel: "condo buildings",
    coverage: (n, total, zip, units) =>
      `${fmt(n)} residential-condo buildings across ${fmt(total)} total lots in ZIP ${zip}${units ? ` (${fmt(units)} units)` : ""}. Live from PLUTO; click any record to drill in.`
  },
  office: {
    where: cls("O"),
    unitField: null,
    topOrder: "bldgarea DESC",
    ownerWhere: cls("O"),
    salesMinPrice: 1000000,
    salesCategories: ["21"],
    salesSf: "gross_square_feet",
    metric: "$/gross sf",
    detailLabel: "office buildings",
    coverage: (n, total, zip) =>
      `${fmt(n)} office buildings across ${fmt(total)} total lots in ZIP ${zip}. Live from PLUTO; click any record to drill in.`
  },
  hotels: {
    where: cls("H"),
    unitField: "unitstotal",
    topOrder: "bldgarea DESC",
    ownerWhere: cls("H"),
    salesMinPrice: 1000000,
    salesCategories: ["25", "26", "45"],
    salesSf: "gross_square_feet",
    metric: "$/gross sf",
    detailLabel: "hotel properties",
    coverage: (n, total, zip, units) =>
      `${fmt(n)} hotel properties across ${fmt(total)} total lots in ZIP ${zip}${units ? ` (${fmt(units)} units)` : ""}. Live from PLUTO; click any record to drill in.`
  },
  development: {
    where: "lotarea > 1500 and builtfar < 1.5 and (residfar >= 3 or commfar >= 4)",
    unitField: null,
    topOrder: "lotarea DESC",
    // The original groups owners over the WHOLE ZIP for this lens and for misc,
    // not over the qualifying set — its pluto_owners query for both carries no
    // mode predicate at all.
    ownerWhere: "",
    salesMinPrice: 150000,
    salesCategories: ["06", "31"],
    salesSf: "land_square_feet",
    metric: "$/land sf",
    detailLabel: "underbuilt parcels",
    coverage: (n, total, zip) =>
      `${fmt(n)} underbuilt parcels (low built-FAR on upzoned land) across ${fmt(total)} total lots in ZIP ${zip}. Live from PLUTO; click any record to drill in.`
  },
  misc: {
    where: NOT_TRACKED_CLASSES,
    unitField: null,
    topOrder: "bldgarea DESC",
    ownerWhere: "",
    salesMinPrice: 250000,
    // Everything none of the other five lenses claims.
    salesCategories: null,
    salesSf: "gross_square_feet",
    metric: "$/gross sf",
    detailLabel: "other / commercial lots",
    coverage: (n, total, zip) =>
      `${fmt(n)} other / commercial lots across ${fmt(total)} total lots in ZIP ${zip}. Live from PLUTO; click any record to drill in.`
  }
};
const MODE = (m) => MODES[m] || MODES.multifamily;
// The lens name is resolved by EXACT key, and anything else — including a
// different case — falls back to multifamily and is echoed as "multifamily".
// Measured 2026-08-19: ?mode=Office and ?mode=MULTIFAMILY and ?mode=bogus and
// ?mode=%20office all answer mode "multifamily" with 11216's 171-row
// multifamily census. The rebuild used to echo the raw parameter back.
const modeFrom = (v) => (Object.prototype.hasOwnProperty.call(MODES, String(v ?? "")) ? String(v) : "multifamily");
// The drill-down's `kind` is normalised to three values, exact-match and
// case-sensitive. Measured 2026-08-19: ?kind=buildings, ?kind=permits,
// ?kind=owners, ?kind=zzz, ?kind=SALES, ?kind=Owner and a missing ?kind all
// answer kind "qualifying" with the qualifying building list; only the exact
// strings "sales" and "owner" select the other two branches. The rebuild used
// to echo the raw parameter and to default to "sales".
const kindFrom = (v) => { const k = String(v ?? ""); return k === "sales" || k === "owner" ? k : "qualifying"; };

const TRACKED_SALE_CATEGORIES = ["07", "08", "14", "12", "13", "15", "16", "17", "21", "25", "26", "45", "06", "31"];
function salesWhere(zips, mode) {
  const m = MODE(mode);
  const zipList = zips.map((z) => `'${escSoql(z)}'`).join(",");
  const classes = m.salesCategories
    ? `(${m.salesCategories.map(cat).join(" or ")})`
    : `not (${TRACKED_SALE_CATEGORIES.map(cat).join(" or ")})`;
  return `zip_code in (${zipList}) and sale_price > ${m.salesMinPrice} and sale_date > '${salesCutoff()}' and ${classes}`;
}

const zipWhere = (zips, extra) => {
  const list = zips.map((z) => `'${escSoql(z)}'`).join(",");
  return extra ? `zipcode in (${list}) and ${extra}` : `zipcode in (${list})`;
};

// The `sources` entries carry the query that produced them, so a reader can
// re-run any number this endpoint reports. Built the same way soql() builds it,
// because soql() does not hand the URL back.
const sourceUrl = (dataset, params) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
  return `${SOCRATA}/resource/${dataset}.json?${qs}`;
};

// The row shape the original returns in `top[]` and in area-detail `buildings[]`:
// the PLUTO projection plus `score` and the complete source row under `raw`.
// borough/block/lot are the raw PLUTO strings there ("3", "1842", "15"), not the
// borough NAME and integers plutoRowToBuilding produces for the map surfaces —
// so they are taken straight off the record rather than reprojected.
//
// EVERY key except `address`, `score` and `raw` is emitted only when the source
// row carries the column it comes from. Socrata omits null columns, so this is
// literally "publish what PLUTO published for this lot". Verified 2026-08-19
// against 12,916 rows the original serves across six lenses, five ZIPs and four
// drill-down kinds: 0 mismatches, key order included. The shapes that used to
// differ, one per PLUTO habit:
//   condo billing lots (R0/RB, lot 75xx) carry no landuse, resarea, comarea,
//     officearea, retailarea, unitsres or unitstotal, and the original omits all
//     seven rather than publishing "" and 0;
//   hotel lots carry no area breakdown, so resArea/comArea/officeArea/retailArea
//     go and unitsRes 0 / unitsTotal 1 stay;
//   `overlay` (overlay1) and `specialDistrict` (spdist1) appear only on the lots
//     that have them, in that order, between `zoning` and `lotArea` — 301 of the
//     12,916 rows carry both and settle the order;
//   maxFar / unusedFar / unusedFarSf are omitted together when residfar, commfar
//     and facilfar are all zero (74 rows), because the derived envelope is not a
//     PLUTO column at all;
//   `address` is the one field that is always present, standing in as "—" when
//     the lot has none (BBL 4161890150, 1000360030);
//   `yearAltered` is yearalter1 ALONE — BBL on ZIP 10314's misc lens publishes 0
//     against yearalter1 "0" / yearalter2 "2010", so the fallback to the second
//     alteration year that plutoRowToBuilding applies is not the original's.
// `unusedFar` is the raw subtraction, not a rounded one: the original serves
// 0.5699999999999994 for 4.8 − 4.23 where a 2-dp round gives 0.57. unusedFarSf
// is that raw value times the lot area, rounded once.
function territoryRow(r) {
  const b = plutoRowToBuilding(r);
  const row = {};
  row.bbl = b.bbl;
  if (present(r, "borocode")) row.borough = String(r.borocode);
  if (present(r, "block")) row.block = String(r.block);
  if (present(r, "lot")) row.lot = String(r.lot);
  row.address = present(r, "address") ? r.address : EM_DASH;
  if (present(r, "zipcode")) row.zip = r.zipcode;
  if (present(r, "latitude")) row.lat = num(r.latitude);
  if (present(r, "longitude")) row.lng = num(r.longitude);
  if (present(r, "bldgclass")) row.bldgClass = r.bldgclass;
  // Unpadded, because that is what the original returns: PLUTO ships "05" and
  // both sides publish "5".
  if (present(r, "landuse")) row.landUse = String(Number(r.landuse) || r.landuse);
  if (present(r, "ownername")) row.owner = r.ownername;
  if (present(r, "zonedist1")) row.zoning = r.zonedist1;
  if (present(r, "overlay1")) row.overlay = r.overlay1;
  if (present(r, "spdist1")) row.specialDistrict = r.spdist1;
  if (present(r, "lotarea")) row.lotArea = num(r.lotarea);
  if (present(r, "bldgarea")) row.bldgArea = num(r.bldgarea);
  if (present(r, "resarea")) row.resArea = num(r.resarea);
  if (present(r, "comarea")) row.comArea = num(r.comarea);
  if (present(r, "officearea")) row.officeArea = num(r.officearea);
  if (present(r, "retailarea")) row.retailArea = num(r.retailarea);
  if (present(r, "numbldgs")) row.numBldgs = num(r.numbldgs);
  if (present(r, "numfloors")) row.numFloors = num(r.numfloors);
  if (present(r, "unitsres")) row.unitsRes = num(r.unitsres);
  if (present(r, "unitstotal")) row.unitsTotal = num(r.unitstotal);
  if (present(r, "yearbuilt")) row.yearBuilt = num(r.yearbuilt);
  if (present(r, "yearalter1")) row.yearAltered = num(r.yearalter1);
  if (present(r, "builtfar")) row.builtFar = num(r.builtfar);
  if (present(r, "residfar")) row.residFar = num(r.residfar);
  if (present(r, "commfar")) row.commFar = num(r.commfar);
  if (present(r, "facilfar")) row.facilFar = num(r.facilfar);
  const maxFar = Math.max(num(r.residfar), num(r.commfar), num(r.facilfar));
  if (maxFar > 0) {
    const unusedFar = Math.max(0, maxFar - num(r.builtfar));
    row.maxFar = maxFar;
    row.unusedFar = unusedFar;
    row.unusedFarSf = Math.round(unusedFar * num(r.lotarea));
  }
  if (present(r, "assessland")) row.assessLand = num(r.assessland);
  if (present(r, "assesstot")) row.assessTotal = num(r.assesstot);
  if (present(r, "lotfront")) row.lotFront = num(r.lotfront);
  if (present(r, "lotdepth")) row.lotDepth = num(r.lotdepth);
  // The original's own scorer WAS recovered on 2026-08-19 — see the derivation
  // on devScoreFromReal in server/live.js. It is the same single rule
  // /api/area-buildings, /api/address and /api/opportunities publish, so every
  // surface answers one number per lot, which is what the original does. It
  // reproduces the original exactly on 2,000 scored lots.
  Object.assign(row, { score: devScoreFromReal(b), raw: r });
  return row;
}

// The development lens — and only the development lens — is re-ordered by score
// after Socrata has ordered and cut it by lot area. Measured 2026-08-19: ZIP
// 11216's twelve top development lots come back from Socrata as 72,873 / 56,908
// / 53,620 / 52,500 sf … and the original publishes them 93 / 91 / 90 / 89 / 86
// / 86 / 85 / 85 / 76 / 76 / 72 / 62 by score, with every tie in the lot-area
// order Socrata gave. The same holds for area-detail's 250 rows on five ZIPs.
// The other five lenses are published in Socrata's order (multifamily's 11216
// scores run 30, 35, 30, 30, 29, 39 …), and so is the kind=owner drill-down even
// on development (11216 / NYC DEPARTMENT OF PARKS AND RECREATION: 31, 34, 31,
// 64, 93, 91 — lot-area order, untouched).
const orderRows = (rows, mode) =>
  mode === "development"
    ? rows.map((row, i) => ({ row, i })).sort((a, b) => (b.row.score - a.row.score) || (a.i - b.i)).map((x) => x.row)
    : rows;

async function plutoCount(zips, extra) {
  const params = { $where: zipWhere(zips, extra), $select: "count(1) as n" };
  const r = await soql(PLUTO, params, { ttlMs: 6 * 3600e3 });
  return { ...r, params, n: r.live ? parseInt(r.rows?.[0]?.n ?? "0", 10) || 0 : 0 };
}

async function censusCount(zips, mode) {
  const m = MODE(mode);
  const select = m.unitField ? `count(1) as n, sum(${m.unitField}) as u` : "count(1) as n";
  const params = { $where: zipWhere(zips, m.where), $select: select };
  const r = await soql(PLUTO, params, { ttlMs: 6 * 3600e3 });
  return {
    ...r,
    params,
    n: r.live ? parseInt(r.rows?.[0]?.n ?? "0", 10) || 0 : 0,
    units: r.live && m.unitField ? Math.round(num(r.rows?.[0]?.u)) : null
  };
}

async function topLots(zips, mode, limit = TOP_LIMIT) {
  const m = MODE(mode);
  const params = { $where: zipWhere(zips, m.where), $order: m.topOrder, $limit: limit };
  const r = await soql(PLUTO, params, { ttlMs: 3600e3 });
  return { ...r, params };
}

// One grouped owners pull per ordering. `$order=b desc` with $limit=60 is the
// query the original publishes as pluto_owners and is what ownersByBuildings is
// sliced from; `$order=u desc` with $limit=12 is the unpublished sixth query
// behind ownersByUnits. Proof that ownersByUnits cannot be a re-sort of the
// first: ZIP 11216 / multifamily leads it with FULTON PROPERTY OWNER LLC, one
// building and 240 units, and that owner is nowhere in the 60 rows ordered by
// building count (the 60th holds two).
async function ownerRollup(zips, mode, { order = "b desc", limit = OWNER_LIMIT } = {}) {
  const m = MODE(mode);
  const params = {
    $where: zipWhere(zips, m.ownerWhere),
    $select: "ownername, count(1) as b, sum(unitsres) as u",
    $group: "ownername",
    $order: order,
    $limit: limit
  };
  const r = await soql(PLUTO, params, { ttlMs: 6 * 3600e3 });
  const rows = (r.rows ?? [])
    // A lot with a placeholder owner is not an owner. MapPLUTO writes two
    // literal placeholders into ownername, and in ZIP 11216 they outrank every
    // real holder on their respective lenses: "UNAVAILABLE OWNER" holds 83 lots
    // ZIP-wide (and 79 of the 167 condo lots), "NAME NOT ON FILE" 3 — enough to
    // top a condo list whose real owners each hold one. Grouping them as owners
    // is what put "UNAVAILABLE OWNER" at the head of "biggest owners" where the
    // original leads with BROOKLYN HOUSING PRESERVATION LP. Dropping both
    // reproduces the original's list exactly: 52 / 23 / 21 / 16 / 14 / 11 / 11 /
    // 10 / 10 / 8 on multifamily, and 53 / 30 / 25 ZIP-wide.
    .filter((x) => !PLACEHOLDER_OWNER.test(String(x.ownername ?? "").trim()))
    // A lot with NO ownername at all is a different case, and the original keeps
    // it: ZIP 11234 groups seven such lots and publishes them as
    // {"name":"—","buildings":7,"units":0}, in both rollups. Dropping the group
    // (which this handler used to do) lost a real seven-lot holding and pulled a
    // six-lot owner up into its place.
    .map((x) => ({ name: present(x, "ownername") ? String(x.ownername) : EM_DASH, buildings: parseInt(x.b, 10) || 0, units: Math.round(num(x.u)) }));
  return { ...r, params, rows };
}

async function areaSales(zips, mode, { withDetail = false } = {}) {
  const m = MODE(mode);
  const params = withDetail
    ? {
      $where: salesWhere(zips, mode),
      $select: `borough, block, lot, address, sale_price, ${m.salesSf}, sale_date`,
      $order: SALES_DETAIL_ORDER,
      $limit: SALES_DETAIL_LIMIT
    }
    : {
      $where: salesWhere(zips, mode),
      $select: `sale_price, ${m.salesSf}, sale_date`,
      $limit: SALES_LIMIT
    };
  const r = await soql(ROLLING_SALES, params, { ttlMs: 3600e3 });
  const rows = (r.rows ?? []).map((x) => {
    const price = sqft(x.sale_price);
    // Computed, not published — see sqft() above for the measurement.
    const sf = sqft(x[m.salesSf]);
    const sfSource = sfPublished(x[m.salesSf]);
    const bbl = x.borough && x.block && x.lot
      ? `${String(x.borough).trim()}${String(parseInt(x.block, 10)).padStart(5, "0")}${String(parseInt(x.lot, 10)).padStart(4, "0")}`
      : null;
    return {
      address: x.address ?? null,
      bbl,
      saleDate: x.sale_date ? String(x.sale_date).slice(0, 10) : null,
      salePrice: price,
      sf: sfSource,
      ppsf: sfSource > 0 ? Math.round(price / sfSource) : null,
      ppsfExact: sfSource > 0 ? price / sfSource : null,
      // The comma-stripped area the record actually supports, carried for the
      // integrity guard and for anyone reading this in a log. Never published.
      sfStripped: sf
    };
  });
  // The drill-down is already sale_date DESC from Socrata and its tie order is
  // Socrata's, so it is left exactly as it arrived. The aggregate's query
  // carries no $order — that query string is published verbatim in `sources` —
  // so latestSaleDate is taken after a local sort instead.
  if (!withDetail) rows.sort((a, b) => String(b.saleDate ?? "").localeCompare(String(a.saleDate ?? "")));
  return { ...r, params, rows };
}

// The trailing-year $/sf sample. See SALES_MIN_SF / SALES_MIN_PPSF /
// SALES_MAX_PPSF for how each bound was bracketed.
const pricedSales = (rows) => rows
  .filter((s) => s.sf > SALES_MIN_SF)
  .map((s) => s.ppsfExact)
  .filter((v) => Number.isFinite(v) && v > SALES_MIN_PPSF && v < SALES_MAX_PPSF);

router.get("/api/territory", async (req, res) => {
  const zips = zipsFrom(req.query.zips);
  const mode = modeFrom(req.query.mode);
  // Measured 2026-08-19: the original answers 400 with this exact body — one
  // sentence, not the `zips_required` code this handler used to publish.
  if (!zips.length) return res.status(400).json({ error: "Provide ZIPs via ?zips= and optional ?mode=" });
  const m = MODE(mode);

  const [total, census, top, owners, ownersUnits, sales] = await Promise.all([
    plutoCount(zips), censusCount(zips, mode), topLots(zips, mode),
    ownerRollup(zips, mode),
    ownerRollup(zips, mode, { order: OWNER_UNITS_ORDER }),
    areaSales(zips, mode)
  ]);

  // Any one of the sources failing means a number on this page would be wrong
  // rather than missing, so the whole answer is unavailable and says which
  // source did not answer. Nothing is estimated to fill the hole.
  const dead = [
    ["pluto_total", total], ["pluto_census", census], ["pluto_top", top],
    ["pluto_owners", owners], ["pluto_owners_by_units", ownersUnits], ["rolling_sales_area", sales]
  ].filter(([, r]) => !r.live);
  if (dead.length) {
    return res.status(503).json({
      provenance: "unavailable",
      error: "territory_source_unavailable",
      message: "One or more authoritative public-record sources did not answer. No figure is estimated in their place.",
      sources: dead.map(([id, r]) => ({ id, error: r.error ?? "unavailable" }))
    });
  }

  const vals = pricedSales(sales.rows);
  const zipLabel = zips.join(", ");
  const topRows = orderRows(top.rows.map(territoryRow), mode);
  // The census keys the original emits are lens-dependent, not a fixed set:
  // totalUnits appears only where the lens counts units (multifamily, condo,
  // hotels) and avgUnitsPerBldg only alongside it when the lens found something
  // to average — ZIP 99999 answers {"totalLots":0,"qualifyingCount":0,
  // "totalUnits":0} with no avgUnitsPerBldg, while ZIP 11419's single
  // zero-unit condo lot answers avgUnitsPerBldg 0. topUnusedBuildableSf appears
  // only on development, where it is the unused buildable area of the twelve
  // top lots.
  const census4 = { totalLots: total.n, qualifyingCount: census.n };
  if (m.unitField) {
    census4.totalUnits = census.units ?? 0;
    if (census.n) census4.avgUnitsPerBldg = Math.round((census.units ?? 0) / census.n);
  }
  if (mode === "development") {
    census4.topUnusedBuildableSf = topRows.reduce((s, b) => s + (b.unusedFarSf || 0), 0);
  }

  return res.json({
    fetchedAt: new Date().toISOString(),
    mode,
    zips,
    census: census4,
    top: topRows,
    ownersByBuildings: owners.rows.slice(0, OWNER_ROWS).sort((a, b) => b.buildings - a.buildings),
    ownersByUnits: ownersUnits.rows.slice(0, OWNER_ROWS).sort((a, b) => b.units - a.units),
    sales: {
      count: sales.rows.length,
      // Median is the raw value on the original (281.5436507936508 for 11216),
      // the average is rounded (11234: median 272.5250278086763, avg 273).
      medianPpsf: median(vals),
      avgPpsf: average(vals) != null ? Math.round(average(vals)) : null,
      window: 12,
      metric: m.metric,
      latestSaleDate: sales.rows[0]?.saleDate ?? null
    },
    coverage: m.coverage(census.n, total.n, zipLabel, census.units ?? 0),
    sources: [
      { id: "pluto_total", label: "PLUTO total lots", endpoint: PLUTO, query: sourceUrl(PLUTO, total.params), status: "ok", count: total.n },
      { id: "pluto_census", label: "PLUTO qualifying census", endpoint: PLUTO, query: sourceUrl(PLUTO, census.params), status: "ok", count: census.n },
      // pluto_top is the only source that reports "empty" rather than "ok" on a
      // zero result. Measured 2026-08-19: ZIP 11234 / development answers
      // pluto_census count 0 status ok, pluto_top count 0 status empty,
      // rolling_sales_area count 0 status ok; ZIP 11697 / office answers
      // pluto_owners count 0 status ok alongside pluto_top status empty.
      { id: "pluto_top", label: "PLUTO top lots (full detail)", endpoint: PLUTO, query: sourceUrl(PLUTO, top.params), status: top.rows.length ? "ok" : "empty", count: top.rows.length },
      { id: "pluto_owners", label: "PLUTO ownership (grouped)", endpoint: PLUTO, query: sourceUrl(PLUTO, owners.params), status: "ok", count: Math.min(owners.rows.length, OWNER_ROWS) },
      { id: "rolling_sales_area", label: "DOF Rolling Sales (area, 12-mo)", endpoint: ROLLING_SALES, query: sourceUrl(ROLLING_SALES, sales.params), status: "ok", count: sales.rows.length }
    ]
  });
});

// The drill-down the territory tiles open. Same predicates, same source, more
// rows: 250 where the census counts all of them.
router.get("/api/area-detail", async (req, res) => {
  const zips = zipsFrom(req.query.zips);
  const mode = modeFrom(req.query.mode);
  const kind = kindFrom(req.query.kind);
  const owner = String(req.query.owner || "");
  // The `owner` key rides along whenever the parameter was sent at all — even
  // empty, even whitespace — on every branch except sales. Measured 2026-08-19:
  // ?kind=buildings&owner= answers {"kind":"qualifying","mode":…,"owner":"",…}
  // and ?kind=sales&owner=FOO answers no owner key at all.
  const ownerEcho = req.query.owner !== undefined;
  // Measured 2026-08-19: the original answers 400 with this exact body for a
  // missing ZIP list AND for kind=owner with no owner — one sentence covering
  // both, not the two codes this handler used to publish (`zips_required` and
  // `owner_required`).
  if (!zips.length || (kind === "owner" && !owner)) {
    return res.status(400).json({ error: "Provide ZIPs via ?zips=, a kind, and owner for kind=owner." });
  }
  const m = MODE(mode);
  const zipLabel = zips.join(", ");

  if (kind === "sales") {
    const sales = await areaSales(zips, mode, { withDetail: true });
    if (!sales.live) return res.status(503).json({ provenance: "unavailable", error: "rolling_sales_unavailable", message: sales.error ?? "unavailable" });
    const rows = sales.rows.map(({ ppsfExact, sfStripped, ...s }) => s);
    return res.json({
      kind,
      mode,
      buildings: [],
      sales: rows,
      coverage: `${fmt(rows.length)} arm's-length sales in ZIP ${zipLabel} over the trailing 12 months.`
    });
  }

  // The owner drill-down is scoped by the LENS's owner predicate, not by the
  // whole ZIP and not by the lens's qualifying predicate. Measured 2026-08-19:
  // BROOKLYN HOUSING PRESERVATION LP in ZIP 11216 on the multifamily lens
  // answers 52 buildings, which is `unitsres >= 1` (the whole ZIP holds 53, and
  // the qualifying `unitsres >= 20` set is far smaller — the list includes lots
  // with 24 and 48 units). The name match is exact and CASE-SENSITIVE: the same
  // owner in lower case answers 0 buildings, where an upper(ownername)
  // comparison answers 52. Rows come back in the lens's own top order.
  if (kind === "owner") {
    const params = {
      $where: `${zipWhere(zips, m.ownerWhere)} and ownername = '${escSoql(owner)}'`,
      $order: m.topOrder,
      $limit: DETAIL_LIMIT
    };
    const r = await soql(PLUTO, params, { ttlMs: 3600e3 });
    if (!r.live) return res.status(503).json({ provenance: "unavailable", error: "pluto_unavailable", message: r.error ?? "unavailable" });
    const out = { kind, mode };
    if (ownerEcho) out.owner = String(req.query.owner);
    out.buildings = r.rows.map(territoryRow);
    out.sales = [];
    // "1 building owned by …", plural everywhere else including zero.
    out.coverage = `${fmt(r.rows.length)} building${r.rows.length === 1 ? "" : "s"} owned by ${owner} in ZIP ${zipLabel}.`;
    return res.json(out);
  }

  const params = { $where: zipWhere(zips, m.where), $order: m.topOrder, $limit: DETAIL_LIMIT };
  const r = await soql(PLUTO, params, { ttlMs: 3600e3 });
  if (!r.live) return res.status(503).json({ provenance: "unavailable", error: "pluto_unavailable", message: r.error ?? "unavailable" });
  const out = { kind, mode };
  if (ownerEcho) out.owner = String(req.query.owner);
  out.buildings = orderRows(r.rows.map(territoryRow), mode);
  out.sales = [];
  out.coverage = `${fmt(r.rows.length)} qualifying ${m.detailLabel} in ZIP ${zipLabel} (showing up to ${DETAIL_LIMIT}).`;
  return res.json(out);
});

export { MODES, territoryRow, medianLowerMiddleSuperseded };
export default router;
