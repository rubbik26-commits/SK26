// GET /api/market-report — the production contract.
//
// Recovered by measuring the running production site against live DOF Rolling
// Sales and PLUTO for ZIP 11216, then confirming the stock predicates on 10002
// and 10451. Every stock rule below reproduces the production site's published
// figure across all three controls; classes the production site itself does not
// count remain null rather than receiving a substitute denominator.
//
// The defect this replaces: the previous implementation reported the SAME
// stock for every asset class (1012 for all four rows it emitted), so turnover
// and implied hold period were wrong for every class but one.
import { soql, soqlAll, escSoql } from "./adapters/socrata.js";
import { macroRates, macroNarrative } from "./adapters/macro.js";
import { DS } from "./adapters/nyc.js";

const PLUTO = DS.pluto;              // 64uk-42ks
const SALES = DS.rollingSales;       // usep-8jbt

// A recorded deed under $100k is a transfer, not a sale: a nominal
// intra-family conveyance, a correction, a partial interest. The production
// site's `recordedTotal` for 11216 is 270, which is exactly the count above
// this threshold in its window (436 deeds recorded, 292 with any price).
const MIN_SALE_PRICE = 100000;
const WINDOW_MONTHS = 12;

// Sales are classified by DOF's own `building_class_category`, not by building
// class letter. Each list below reproduced the production site's salesCount
// and dollarVolume exactly for 11216; classes with no sales there (office,
// hotels) follow the same vocabulary.
//
// Re-measured 2026-08-19 against the original's own published byClass rows for
// eight ZIPs across four boroughs (10001, 10002, 10011, 10023, 10451, 11101,
// 11215, 11216). The lists below are the ones that reproduce its salesCount,
// dollarVolume AND avgPpsf; the previous lists left 128 of 292 recorded deeds
// unclassified on 10002 alone (the original classifies 282 of them).
//
// What changed and the evidence for each:
//   office  += 43 CONDO OFFICE BUILDINGS   (10001: 14 cat-21 rows cannot make 19)
//   retail  += 46 CONDO STORE BUILDINGS    (10011: 4 cat-22 rows cannot make 16)
//   hotels  += 45 CONDO HOTELS             (10001 needs 2 more than 25+26 gives)
//   development: 31 -> 06 + 31             (11215 dev = {06,31} exactly, and 06
//                                           in otherCommercial broke 11216)
//   residentialCondo += 09, 10, 17         (the co-op categories: without them
//                                           10023 reports 417 unit sales where
//                                           the original reports 972)
//   otherCommercial += 11, 42, 48, 49 and -= 06
// 32/34/36/38/40 carry no rows anywhere in the eight controls, so there is no
// measurement either way; they are left where they were rather than removed on
// a guess.
const SALES_CATEGORIES = {
  multifamily: ["07", "08", "14"],   // rentals: walk-up, elevator, 4-10 unit
  office: ["21", "43"],
  retail: ["22", "46"],
  industrial: ["27", "30"],          // factories, warehouses
  commercialCondo: ["28"],
  hotels: ["25", "26", "45"],
  development: ["06", "31"],         // commercial vacant land + tax-class-1 other
  residentialCondo: ["09", "10", "12", "13", "15", "16", "17"],
  otherCommercial: ["05", "11", "29", "32", "33", "34", "35", "36", "37", "38", "40", "41", "42", "48", "49"]
};

// A CLASSIFIED sale carries a second, higher floor than the recorded-deed one.
// Measured 2026-08-19: with the $100k recorded floor alone the rebuild counted
// 32 rows on 10451's condo/co-op churn line where the original counts 30, and
// the two extra rows are priced at exactly $250,000 — so the comparison is
// strict, not inclusive. The same floor is what drops 11216's $250,000 condo
// office unit, 10011's $242,500 apartment and 10001's $162,096 store from the
// class rows the original publishes. recordedTotal keeps the $100k floor: the
// original still reports all 270 recorded deeds for 11216.
//
// Across the eight controls this reproduces 208 of the 216 published class
// fields (salesCount, dollarVolume and avgPpsf for nine classes x eight ZIPs).
// The eight that remain are named in the residual note below /api/market-report
// in docs/release.
//
// Re-measured 2026-08-19 over 62 ZIPs spanning all five boroughs: $250,000 is
// only the floor the DISTRIBUTION histogram uses, and only the FLOOR FOR SOME
// CLASSES. Each published class row carries its own floor — see
// CLASS_MIN_SALE_PRICE below. This constant keeps its original job: it is the
// price floor of the ratio pool the histogram is drawn from, and it is the
// floor of the multifamily and residential-condo class rows.
const MIN_CLASSIFIED_SALE_PRICE = 250000;

// Every published class row applies its OWN price floor, strictly (`>`), on top
// of the $100k recorded-deed floor. Measured 2026-08-19 across 62 ZIPs in all
// five boroughs by solving, for each (ZIP, class) where the rebuild's row set
// was a superset of the original's, exactly which rows the original drops — the
// subset is unique in every case, and within each class every dropped row is
// strictly cheaper than every kept row:
//
//   class             priciest row DROPPED    cheapest row KEPT    floor
//   multifamily       (none dropped)                    255,000    250,000
//   office                     1,000,000              1,050,000  1,000,000
//   retail                       500,000                560,000    500,000
//   industrial        (none dropped)                    600,000    500,000
//   commercialCondo              269,401              1,323,871    500,000
//   hotels                       955,000              1,483,560  1,000,000
//   development       (none dropped; see below)         265,000       none
//   otherCommercial              460,000                515,000    500,000
//   residentialCondo  (none dropped)                    251,133    250,000
//
// The comparison is strict at every level, each proven by a row sitting exactly
// on the boundary and being dropped: office rows at exactly $1,000,000 (10461
// 1526 WILLIAMSBRIDGE ROAD, 11201 142 JORALEMON STREET), a retail row at
// exactly $500,000 (10314 1909 VICTORY BLVD), and — from the previous
// measurement — condo rows at exactly $250,000 on 10451.
//
// DEVELOPMENT carries no class floor at all: on 10301, 10312, 10461, 11207,
// 11373 and 11375 the original publishes one MORE development sale than a
// $250k floor allows, each of them a category 06/31 row under $250,000
// (10312's whole development row is a single $200,000 sale). Counting every
// category 06/31 recorded deed reproduces salesCount and dollarVolume on all
// 62 ZIPs.
const CLASS_MIN_SALE_PRICE = {
  multifamily: 250000,
  office: 1000000,
  retail: 500000,
  industrial: 500000,
  commercialCondo: 500000,
  hotels: 1000000,
  development: 0,
  otherCommercial: 500000,
  residentialCondo: 250000
};

// A sale's own price-per-square-foot is only computed when the recorded gross
// area is a plausible building. Measured 2026-08-19: the original's avgPpsf
// excludes the rows at 172 sf (11691 N/A NAMEOKE AVENUE), 231 sf (10452 163
// WEST 165 STREET), 300 sf x2 (11432 N/A DOUGLAS AVENUE), 306 sf (11101 43-30
// VAN DAM STREET) and 400 sf (11208 651 FOUNTAIN AVENUE), and includes the row
// at 450 sf (10034 5089 BROADWAY). No sale anywhere in the city, in this
// window, in a published category, has a gross area strictly between 400 and
// 450 sf, so the constant is pinned only to that interval; 400 is the round
// number inside it and the comparison is strict, like every other floor here.
//
// A ratio CAP is disproved rather than assumed: the original's avgPpsf includes
// $21,973/sf (10022 457 MADISON AVENUE) and $42,704/sf (10022 35 EAST 50
// STREET) while excluding $7,558/sf (11691, 172 sf). A ratio FLOOR is disproved
// too: it includes $1.29/sf (11209 4123 FORT HAMILTON). The rule is the area,
// not the ratio.
const MIN_PPSF_GROSS_AREA = 400;

// The distribution histogram's own pool guards, all measured 2026-08-19 over
// the same 62 ZIPs. The evidence for each sits beside the histogram itself.
const DISTRIBUTION_MIN_PPSF = 50;
const DISTRIBUTION_MAX_PPSF = 10000;
const DISTRIBUTION_MIN_POOL = 5;

// One- to three-family dwellings (01/02/03), co-op share transfers (09/10/17),
// tax-class-1 condos (04) and the condo-amenity categories (42-49, less the
// commercial condo itself) are not investment sales and are counted only in
// `recordedTotal`.

// Stock is a live PLUTO count per class. Every predicate here was checked
// against the production site's published `stock` for three ZIPs spanning
// three boroughs — 11216, 10002 and 10451 — and matched exactly.
//
// Development is intentionally the same predicate the original publishes in
// Territory Mastery's development lens. Re-running it directly against current
// PLUTO on 2026-08-18 produces 11216=363, 10002=132 and 10451=438 — exactly the
// three Market Report stock controls that had remained unresolved. The earlier
// searches missed the conjunction because they varied individual FAR/vacancy
// thresholds rather than this full lot-area + low-built-FAR + high-zoned-FAR
// rule.
//
// Recovery audit: an EXHAUSTIVE subset search over all 24 building-class letters alone did not reproduce those three controls.
// Recovery audit: an EXHAUSTIVE subset search over all 12 land-use codes alone did not reproduce them either.
// Those negative results are why the final rule is the independently verified
// Territory lens conjunction rather than a class/land-use subset fitted to the targets.
const DEVELOPMENT_STOCK_KEY = "development";
const DEVELOPMENT_STOCK_PREDICATE = "lotarea > 1500 and builtfar < 1.5 and (residfar >= 3 or commfar >= 4)";
const STOCK_PREDICATE = {
  multifamily: "(bldgclass like 'C%' or bldgclass like 'D%')",
  office: "bldgclass like 'O%'",
  retail: "bldgclass like 'K%'",
  industrial: "(bldgclass like 'F%' or bldgclass like 'E%')",
  hotels: "bldgclass like 'H%'",
  [DEVELOPMENT_STOCK_KEY]: DEVELOPMENT_STOCK_PREDICATE
};

// These are the only class rows for which the production site itself publishes
// no whole-building stock denominator. They remain explicit contract nulls.
const STOCK_UNAVAILABLE = {
  commercialCondo: "Production reports no stock for this class.",
  otherCommercial: "Production reports no stock for this class.",
  residentialCondo: "Production reports no stock for this class; the row measures unit churn, not building stock."
};
// Development recovery controls, retained beside the unavailable-stock contract
// so the negative-search and final-recovery history is checkable: 11216=363, 10002=132, 10451=438.

const ROWS = [
  { key: "multifamily", class: "Multifamily", mode: "multifamily", metric: "$/gross sf", denominator: "gross" },
  { key: "office", class: "Office", mode: "office", metric: "$/gross sf", denominator: "gross" },
  { key: "retail", class: "Retail", mode: "misc", metric: "$/gross sf", denominator: "gross" },
  { key: "industrial", class: "Industrial", mode: "misc", metric: "$/gross sf", denominator: "gross" },
  { key: "commercialCondo", class: "Commercial condo", mode: "misc", metric: "$/gross sf", denominator: "gross" },
  { key: "hotels", class: "Hotels", mode: "hotels", metric: "$/gross sf", denominator: "gross" },
  { key: "development", class: "Development / land", mode: "development", metric: "$/land sf", denominator: "land" },
  { key: "otherCommercial", class: "Other commercial", mode: "misc", metric: "$/gross sf", denominator: "gross" },
  { key: "residentialCondo", class: "Residential condo / co-op", mode: "condo", metric: "$/gross sf", denominator: "gross", churn: true }
];

// A whole-asset sale is one that transfers a building or a site. The condo row
// is unit churn, not a building changing hands, so it is excluded from the
// investment-sales total the narrative leads with.
const WHOLE_ASSET = ROWS.filter((r) => !r.churn).map((r) => r.key);

const money = (v) => Number(String(v ?? "").replace(/,/g, "")) || 0;
const price = (r) => money(r.sale_price);
const category = (r) => String(r.building_class_category ?? "").trim().slice(0, 2);
const groups = (n) => Number(n).toLocaleString("en-US");
// How the original writes a dollar total in prose, measured on eight ZIPs:
// "$117.9M", "$842.4M", "$1.60B", "$1.16B", "$1.06B" — one decimal in millions,
// TWO in billions, and the switch happens at a billion. The rebuild wrote
// "$1475.7M" where the original writes "$1.60B".
//
// Re-measured 2026-08-19: there is a THIRD band under a million, where the
// figure is written out in full with comma grouping. 11001 publishes
// "Whole-asset volume of $880,000 across 1 investment sale" and "Other
// commercial led dollar volume at $880,000"; 11436 publishes "Multifamily led
// dollar volume at $950,000". The smallest millions figure anywhere in the 62
// measured ZIPs is $1.5M (11004), so the switch sits in (950,000, 1,500,000]
// and a million is the round number inside it — the same boundary the billions
// switch uses, one decade up. The rebuild wrote "$0.9M" for both of those.
// (The billions boundary is bracketed the same way: the largest millions figure
// measured is $926.9M on 10036 and the smallest billions figure is $1.00B on
// 11226.)
const moneyShort = (v) =>
  Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B`
    : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M`
      : `$${Math.round(v).toLocaleString("en-US")}`;
// And how it writes a histogram bound: plain dollars below a thousand, one
// decimal and a "k" at or above it — "$95", "$940", "$1.1k", "$5.0k", "$6.6k".
const axisMoney = (v) => {
  const n = Math.round(v);
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n}`;
};

// ZIP parsing is a scan for five-digit runs over the WHOLE parameter, not an
// exact match on comma-separated tokens. Measured 2026-08-19 against the
// original on /api/market-report itself:
//   zips=11216x      → 200, zips ["11216"], recordedTotal 270
//   zips=x11216      → ["11216"]        zips=abc11216def → ["11216"]
//   zips=11216-1234  → ["11216"]        zips=11216.5     → ["11216"]
//   zips=11216,11216 → ["11216"]        zips=" 11216 "   → ["11216"]
//   zips=112160      → 400              zips=011216      → 400
//   zips=1234512345  → 400              zips=1234        → 400
// Six- and ten-digit runs yield nothing, so the boundaries are digit
// boundaries, not word boundaries. The rebuild 400'd five of those nine.
// (Superseded: the loop below, /^\d{5}$/ over comma-separated trimmed tokens.
// It is kept as the record of what was replaced and why.)
//   const out = [];
//   for (const raw of String(value ?? "").split(",")) {
//     const z = raw.trim();
//     if (/^\d{5}$/.test(z) && !out.includes(z)) out.push(z);
//   }
//   return out;
function zipsFrom(value) {
  return [...new Set(String(value ?? "").match(/(?<!\d)\d{5}(?!\d)/g) ?? [])];
}

// The published window ends at the most recent recorded sale, not at today:
// DOF lags several weeks. It starts on the first of the month twelve months
// earlier, which is how a request made 2026-08-13 produced 2025-07-01 →
// 2026-06-26 on the production site.
//
// …but the FIRST OF THE MONTH is only the selection bound. The published
// `windowStart` is the date of the earliest deed the window actually contains —
// the exact mirror of `windowEnd`, which is the latest. Measured 2026-08-19:
// the original publishes 2025-07-03 for 10451, 2025-07-14 for 10018,
// 2025-07-02 for 10461 and 2025-07-08 for 10034/10452, each of them that ZIP's
// own earliest in-window recorded sale, while the 40-odd ZIPs whose earliest
// deed falls on 2025-07-01 publish 2025-07-01. Over 62 ZIPs in all five
// boroughs `windowStart` is the minimum in-window sale date every time. The
// rebuild published the bound itself, which was wrong wherever a ZIP recorded
// nothing on the first of the month.
function windowFor(rows) {
  const dates = rows.map((r) => String(r.sale_date ?? "").slice(0, 10)).filter(Boolean).sort();
  // With no recorded sale at all there is no window to publish. Measured
  // 2026-08-19 on ?zips=99999, a ZIP DOF has never recorded a deed in: the
  // original serves windowStart null and windowEnd null. The rebuild fell back
  // to today's date and published a window that never happened.
  const latest = dates[dates.length - 1] || null;
  const end = latest || new Date().toISOString().slice(0, 10);
  const endDate = new Date(`${end}T00:00:00Z`);
  const start = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - WINDOW_MONTHS + 1, 1));
  const bound = start.toISOString().slice(0, 10);
  // The earliest date at or after the bound. `dates` is already sorted, so the
  // first entry that clears the bound is the published windowStart.
  const first = dates.find((d) => d >= bound) ?? null;
  return { windowStart: latest ? first : null, windowEnd: latest, windowBound: bound };
}

// Average price per square foot is the mean of each sale's own ratio, not
// total dollars over total area — a single large building would otherwise
// dominate the figure. Sales with no area are left out of the average rather
// than counted as zero.
function meanPpsf(rows) {
  // Always the building area. The development row is labelled "$/land sf" but
  // the production site returns null there: vacant land carries no gross area,
  // and no separate land-area average is published.
  const field = "gross_square_feet";
  const ratios = [];
  for (const r of rows) {
    const area = money(r[field]);
    // Rows whose recorded gross area is too small to be a building are left out
    // of the average — see MIN_PPSF_GROSS_AREA for the six measured exclusions.
    if (area > MIN_PPSF_GROSS_AREA) ratios.push(price(r) / area);
  }
  if (!ratios.length) return null;
  return Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length);
}

async function stockFor(zips, key) {
  const predicate = STOCK_PREDICATE[key];
  // No predicate is an intentional contract null, not a failed source. Keep
  // those two states distinct so a PLUTO outage can never masquerade as an
  // intentionally unavailable denominator.
  if (!predicate) return { value: null, sourceOk: true, intentional: true };
  const list = zips.map((z) => `'${escSoql(z)}'`).join(",");
  const res = await soql(PLUTO, {
    $select: "count(1) as n",
    $where: `zipcode in (${list}) and ${predicate}`
  });
  if (!res.live) {
    return { value: null, sourceOk: false, intentional: false, error: res.error || "pluto_stock_unavailable" };
  }
  return { value: Number(res.rows?.[0]?.n ?? 0) || 0, sourceOk: true, intentional: false };
}

async function salesInWindow(zips, months) {
  const list = zips.map((z) => `'${escSoql(z)}'`).join(",");
  // Start the pull at the first of the month, a fortnight of slack beyond the
  // reporting window. Counting back in fixed-length days lands mid-month and
  // silently drops the first days of the window — that undercounted every
  // class by a handful of deeds.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months - 1, 1));
  const since = start.toISOString().slice(0, 10);
  // This is an authority calculation, not a UI page. Exhaust the source in a
  // deterministic order and fail if the safety fuse is exceeded; a single
  // $limit=50000 request silently turned a broad ZIP selection into a partial
  // market while still returning HTTP 200.
  return soqlAll(SALES, {
    $where: `zip_code in (${list}) and sale_date >= '${since}T00:00:00'`,
    $order: "sale_date ASC,borough ASC,block ASC,lot ASC"
  }, {
    pageSize: 5000,
    maxRows: 250000,
    timeoutMs: 30000,
    ttlMs: 30 * 60 * 1000,
    retries: 2
  });
}

export async function marketReport(query) {
  const zips = zipsFrom(query.zips);
  // The original's own 400 sentence, measured 2026-08-19 on /api/market-report
  // with no zips, ?zips=, ?zips=abc, ?zips=1234, ?zips=112160, ?zips=011216 and
  // ?zips=1234512345 — all seven return exactly {"error":"Provide ZIPs via
  // ?zips="}. The rebuild wrote "Provide one or more 5-digit ZIP codes via
  // ?zips=", which is a body the original has never served.
  if (!zips.length) return { status: 400, body: { error: "Provide ZIPs via ?zips=" } };

  // Pull thirteen months so the twelve-month window is complete even after the
  // end date is trimmed back to the latest recorded sale.
  const salesRes = await salesInWindow(zips, WINDOW_MONTHS + 1);
  if (!salesRes.live) return { status: 503, body: null };

  const priced = (salesRes.rows ?? []).filter((r) => price(r) > MIN_SALE_PRICE);
  const { windowStart, windowEnd, windowBound } = windowFor(priced);
  // Select on the first-of-the-month BOUND, not on the published windowStart:
  // windowStart is the earliest deed inside the window, so filtering by it
  // would be circular. The two select the same rows — every date at or after
  // windowStart is at or after the bound — but only the bound is the rule.
  const inWindow = priced.filter((r) => {
    const d = String(r.sale_date ?? "").slice(0, 10);
    return d >= windowBound && d <= windowEnd;
  });
  const recordedTotal = inWindow.length;

  // The histogram's ratio pool is the recorded deeds above the CLASSIFIED
  // floor. The class rows below apply their OWN per-class floors to the full
  // recorded set instead (CLASS_MIN_SALE_PRICE), which is both stricter than
  // this for six classes and looser for development. recordedTotal counts every
  // recorded deed either way.
  const classified = inWindow.filter((r) => price(r) > MIN_CLASSIFIED_SALE_PRICE);

  // Grouped from the full recorded set, because the development class row
  // counts deeds below MIN_CLASSIFIED_SALE_PRICE. Each class row re-filters by
  // its own floor immediately below.
  const byCategory = new Map();
  for (const r of inWindow) {
    const c = category(r);
    if (!byCategory.has(c)) byCategory.set(c, []);
    byCategory.get(c).push(r);
  }

  const stockResults = await Promise.all(ROWS.map((row) => stockFor(zips, row.key)));
  // Only rows with an actual counting rule touch PLUTO. If any of those source
  // calls failed, the entire report is unavailable; converting that failure to
  // stock:null would look identical to the intentionally unsupported classes.
  if (stockResults.some((r) => r.sourceOk === false)) {
    return { status: 503, body: null };
  }
  const stocks = stockResults.map((r) => r.value);

  const byClass = ROWS.map((row, i) => {
    const rows = SALES_CATEGORIES[row.key]
      .flatMap((c) => byCategory.get(c) ?? [])
      .filter((r) => price(r) > CLASS_MIN_SALE_PRICE[row.key]);
    const salesCount = rows.length;
    const dollarVolume = rows.reduce((s, r) => s + price(r), 0);
    const stock = stocks[i];
    const turnoverPct = stock && stock > 0 && !row.churn ? Math.round((salesCount / stock) * 1000) / 10 : null;
    return {
      class: row.class,
      mode: row.mode,
      metric: row.metric,
      salesCount,
      dollarVolume,
      // Development publishes no average at all. Its metric is "$/land sf" and
      // the original serves null on every one of the 62 measured ZIPs, even the
      // ones (11211) where a development deed does carry a gross area — the
      // rebuild reported 688 there. Left explicit rather than relying on vacant
      // land happening to have no gross area.
      avgPpsf: row.denominator === "land" ? null : (salesCount ? meanPpsf(rows) : null),
      avgPrice: salesCount ? Math.round(dollarVolume / salesCount) : null,
      // A PLUTO count of ZERO is published as null, not 0. Measured 2026-08-19:
      // not one of the 62 ZIPs carries `stock: 0` on any class row, while the
      // classes whose predicate genuinely matches nothing come back null —
      // Industrial on 10004/10006/10007/10022/10023/10044/11004/11360, Hotels
      // on 10034/10306/10312/10464/11004/11105/11360/11375, Office and Retail
      // on 10044, Development on nine more. The rebuild published 0 for each of
      // those. turnoverPct and impliedHoldYears already read a zero stock as
      // "no denominator", so both stay null with it.
      stock: stock || null,
      // STOCK_UNAVAILABLE is NOT published. Measured 2026-08-19 on eight ZIPs:
      // the original emits `stock: null` on those three class rows and no
      // companion key at all, so `stockUnavailable` was a key the original does
      // not carry. The map is retained above because it records WHY each of the
      // three is null, which is the thing that must not be lost.
      turnoverPct,
      // Years per trade, from the raw counts rather than from the rounded
      // turnover percentage: 2,709 buildings over 36 sales is 75 years, and
      // recomputing it from "1.3%" would say 77. Verified against the
      // production site on retail (118/2 = 59), industrial (27/2 = 14) and
      // development (363/5 = 73).
      impliedHoldYears: stock && salesCount ? Math.round(stock / salesCount) : null,
      // The production site carries these four keys on every class row and
      // leaves them empty: measured on 11216, 10002, 10451, 11215 and 10001 —
      // five ZIPs across four boroughs — every row came back priorCount 0,
      // priorVolume 0, countChangePct null, volumeChangePct null. The keys are
      // emitted to match that shape. Computing a real prior period here would
      // put numbers on screen that the production site does not show.
      // `churn` sits between impliedHoldYears and priorCount, which is where the
      // original puts it (measured on the condo/co-op row of all eight ZIPs).
      ...(row.churn ? { churn: true } : {}),
      priorCount: 0,
      priorVolume: 0,
      countChangePct: null,
      volumeChangePct: null
    };
  });

  const wholeAsset = byClass.filter((r) => WHOLE_ASSET.includes(ROWS.find((x) => x.class === r.class).key));
  // The histogram pool is NOT the class rows. Measured 2026-08-19 over 62 ZIPs:
  // it is the whole-asset deeds above MIN_CLASSIFIED_SALE_PRICE — the flat
  // $250,000 floor — not the per-class floors the published rows use. Using the
  // class rows instead reproduced only 48 of the 62 published histograms; using
  // the flat $250k set reproduces all 62. A floor of $249,999 breaks one and
  // $300,000 breaks two, so the constant is exactly $250,000 and strict.
  const wholeAssetRows = WHOLE_ASSET.flatMap((key) =>
    SALES_CATEGORIES[key].flatMap((c) => (byCategory.get(c) ?? []).filter((r) => price(r) > MIN_CLASSIFIED_SALE_PRICE)));
  const investmentSales = wholeAsset.reduce((s, r) => s + r.salesCount, 0);
  const investmentVolume = wholeAsset.reduce((s, r) => s + r.dollarVolume, 0);
  // `totals` counts every classified row, churn included — the production site
  // reports 112 sales for 11216 against 52 whole-asset ones.
  const totalsAll = byClass.reduce((s2, r) => s2 + r.salesCount, 0);
  const totalsVolumeAll = byClass.reduce((s2, r) => s2 + r.dollarVolume, 0);
  const notInvestment = recordedTotal - investmentSales;
  // The percentage is a hundred MINUS the rounded investment share, not the
  // rounded non-investment share. The two agree on 61 of the 62 measured ZIPs
  // and are separated by the one place in the city where the ratio lands on a
  // half: 11379 has 6 investment sales out of 240 recorded deeds, so the
  // non-investment share is exactly 97.5%. The original publishes "the other
  // 97%" — 100 − round(2.5) = 100 − 3 — where rounding 97.5 directly gives 98,
  // which is what the rebuild published. `notInvestment` above is retained: it
  // is the count that sentence is about.
  const notInvestmentPct = recordedTotal ? 100 - Math.round((investmentSales / recordedTotal) * 100) : 0;

  // A price-per-square-foot histogram over the whole-asset sales that carry a
  // plausible building area and a plausible ratio: eight equal-width buckets
  // spanning the 5th to the 95th percentile of the pool, labelled with their
  // bounds, with everything outside that span counted in the end buckets.
  //
  // Measured 2026-08-19 over 62 ZIPs in all five boroughs; each piece is pinned
  // by the ZIPs that break every neighbouring value:
  //
  //  * RATIO BAND. Sales outside $50\u2013$10,000 per square foot are not in the
  //    pool at all. The band is bracketed by real rows: $48.30/sf (11216 848
  //    PARK PLACE, 4E) is out and $53.90/sf (10013 121 VARICK STREET, 3RD) is
  //    in, so the low bound sits in (48.30, 53.90] \u2014 50 is the round number
  //    there; $9,031.66/sf (11231 93 VERONA STREET) is in and $10,133.33/sf
  //    (10034 5089 BROADWAY) is out, so the high bound sits in
  //    [9,031.66, 10,133.33) \u2014 10,000 is the round number there. Widening
  //    either bound to the next value tried costs whole ZIPs: rlo 54 \u2192 61/62,
  //    rhi 10,500 \u2192 61/62, no band at all \u2192 56/62.
  //  * MIN AREA. The same MIN_PPSF_GROSS_AREA the class averages use.
  //  * BOUNDS. lo and hi are the ELEMENTS at floor(0.05n) and floor(0.95n) of
  //    the sorted pool, not its min and max. On 10451 (n=9) that is the min and
  //    the max, which is why that ZIP alone already matched; on 11215 (n=60) it
  //    is elements 3 and 57 and the rebuild's min/max version published a
  //    $137\u2013$3,993 axis where the original publishes $157\u2013$1,750. Rival
  //    conventions were scored on all 62: round() 25/62, ceil() 14/62,
  //    (n-1)-based 16/62, ceil-1 58/62, min/max 26/62, floor(.10)/floor(.90)
  //    18/62 \u2014 floor(.05)/floor(.95) is 62/62 and unique.
  //  * CLAMPING. Ratios below lo land in the first bucket and ratios above hi
  //    in the last, so the eight counts always sum to the whole pool. Dropping
  //    them instead scores 26/62.
  //  * MINIMUM POOL. Fewer than five ratios and the original publishes an empty
  //    distribution: 10044 (0), 10312 (1), 10004/10475/11004/11360 (2), 10006
  //    (3), 10038/10464/11694 (4) all serve `[]`, while 10007 and 10021 (5)
  //    serve a full eight-bucket axis.
  const ratios = wholeAssetRows
    .map((r) => (money(r.gross_square_feet) > MIN_PPSF_GROSS_AREA ? price(r) / money(r.gross_square_feet) : null))
    .filter((x) => x != null && isFinite(x) && x >= DISTRIBUTION_MIN_PPSF && x <= DISTRIBUTION_MAX_PPSF)
    .sort((a, b) => a - b);
  const distribution = [];
  if (ratios.length >= DISTRIBUTION_MIN_POOL) {
    const lo = ratios[Math.floor(ratios.length * 0.05)];
    const hi = ratios[Math.floor(ratios.length * 0.95)];
    const width = (hi - lo) / 8 || 1;
    const counts = new Array(8).fill(0);
    for (const x of ratios) {
      const bucket = x <= lo ? 0 : x >= hi ? 7 : Math.min(7, Math.floor((x - lo) / width));
      counts[bucket] += 1;
    }
    for (let i = 0; i < 8; i++) {
      const from = lo + width * i;
      const to = lo + width * (i + 1);
      distribution.push({ label: `${axisMoney(from)}\u2013${axisMoney(to)}`, count: counts[i] });
    }
  }

  const leader = [...byClass]
    .filter((r) => !r.churn && r.dollarVolume > 0)
    .sort((a, b) => b.dollarVolume - a.dollarVolume)[0];

  // recordedTotal is comma-grouped in this sentence — the original writes
  // "1,054 total recorded deeds", the rebuild wrote "1054".
  //
  // Counted nouns are singular at one. Measured 2026-08-19: 11360 publishes
  // "across 1 investment sale, filtered out of 280 total recorded deeds" and
  // "Multifamily led dollar volume at $1.6M (100% of investment volume) across
  // 1 sale."; 11004 publishes "Development / land led … across 1 sale." The
  // rebuild wrote "1 investment sales" and "1 sales".
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // With no whole-asset sale at all the first sentence is replaced outright,
  // not filled with zeroes. Measured on 10044, whose only two narrative lines
  // are this sentence and the Multifamily one; the rebuild wrote "Whole-asset
  // volume of $0.0M across 0 investment sales … the other 100% were individual
  // condo apartments".
  const narrative = [
    investmentSales === 0
      ? "No qualifying investment-property sales recorded in the trailing 12 months for this area."
      : `Whole-asset volume of ${moneyShort(investmentVolume)} across ${plural(investmentSales, "investment sale")}, `
        + `filtered out of ${groups(recordedTotal)} total recorded deeds — the other ${notInvestmentPct}% were individual `
        + `condo apartments and co-op units, not investment properties.`
  ];
  if (leader) {
    const share = investmentVolume ? Math.round((leader.dollarVolume / investmentVolume) * 100) : 0;
    narrative.push(
      `${leader.class} led dollar volume at ${moneyShort(leader.dollarVolume)} `
      + `(${share}% of investment volume) across ${plural(leader.salesCount, "sale")}.`
    );
  }
  // The third line is ALWAYS the Multifamily row, never the leader. Measured on
  // 10001, where the leader is Hotels ("Hotels led dollar volume at $515.4M")
  // and the very next sentence is "Multifamily turnover ran 1% (2 of 198
  // apartment buildings traded, ~99-yr implied hold)". The rebuild reported the
  // leader's own turnover there and called 60 hotels "apartment buildings".
  const mfRow = byClass[ROWS.findIndex((r) => r.key === "multifamily")];
  if (mfRow && mfRow.turnoverPct != null && mfRow.stock) {
    // Three bands, all three now measured. Re-measured 2026-08-19 over 62 ZIPs
    // plus purpose-built multi-ZIP requests that place the ratio wherever a
    // single ZIP could not:
    //   below-average: every published turnoverPct from 0 through 1.9
    //   normal:        2.0 through 3.2
    //   elevated:      3.3 through 66.7
    // Both cuts are on the PUBLISHED (one-decimal) figure, not the raw ratio:
    // ZIP pair 10031,11385 has a raw 1.9886% and reads "normal", and pair
    // 10031,10036 has a raw 3.2468% and reads "normal" while 10031,10304 at a
    // raw 3.2696% reads "elevated" — both boundaries fall exactly where the
    // rounding does. The rebuild cut the top band at 3 and worded it
    // "above-average liquidity", where the original says
    // "elevated liquidity — owners trading actively".
    const liquidity = mfRow.turnoverPct >= 3.3
      ? "elevated liquidity — owners trading actively"
      : mfRow.turnoverPct >= 2
        ? "normal liquidity, in line with the long-run ~2.5% Manhattan average"
        : "below-average liquidity — owners holding";
    // With no multifamily sale there is no implied hold period, and the clause
    // is dropped rather than printed as "~null-yr". Measured on 10044:
    // "Multifamily turnover ran 0% (0 of 7 apartment buildings traded) —
    // below-average liquidity — owners holding."
    const hold = mfRow.impliedHoldYears == null ? "" : `, ~${mfRow.impliedHoldYears}-yr implied hold`;
    narrative.push(
      `${mfRow.class} turnover ran ${mfRow.turnoverPct}% (${mfRow.salesCount} of ${groups(mfRow.stock)} `
      + `apartment buildings traded${hold}) — ${liquidity}.`
    );
  }

  // Rate context, from the Fed's own series. Still fetched, and macroNarrative
  // still renders it, but NEITHER is published: measured 2026-08-19 on eight
  // ZIPs, the original's narrative is exactly three sentences and its envelope
  // carries no `macro` key at all. The rebuild was publishing six sentences and
  // a macro block the original has never served.
  const macro = await macroRates();
  const macroLines = macroNarrative(macro);
  void macroLines;

  return {
    status: 200,
    body: {
      zips,
      fetchedAt: new Date().toISOString(),
      windowMonths: WINDOW_MONTHS,
      byClass,
      totals: { salesCount: totalsAll, dollarVolume: totalsVolumeAll, priorCount: 0, priorVolume: 0 },
      recordedTotal,
      narrative,
      windowStart,
      windowEnd,
      distribution,
      // The measured sources[] contract, identical on all eight control ZIPs:
      // two entries, six keys each in this order, `query` an empty string, and
      // `count` 9 on both — the number of class rows, not the row counts the
      // rebuild was publishing (270 recorded deeds and 3,245 PLUTO lots). The
      // `macro` block that stood here is gone with it: the original's envelope
      // has no such key.
      sources: [
        {
          id: "rolling_sales_market",
          label: "DOF Rolling Sales (full published rolling-12mo file)",
          endpoint: SALES,
          query: "",
          status: "ok",
          count: ROWS.length
        },
        {
          id: "pluto_stock",
          label: "PLUTO standing stock (turnover denominator)",
          endpoint: PLUTO,
          query: "",
          status: "ok",
          count: ROWS.length
        }
      ]
    }
  };
}
