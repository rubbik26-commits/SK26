// Live opportunities generator — the production /api/opportunities contract:
// an array of ~150 parcels in the original field vocabulary (verified against
// the running production site), derived from real PLUTO records instead of the
// scaffold's synthetic generator. Scores use the platform's own client-side
// formula so every on-screen breakdown reconciles with the raw fields.
import { plutoTopByBorough } from "./adapters/nyc.js";
import { devScoreFromReal } from "./live.js";
import { SEED_PARCELS } from "./seed-parcels.js";
import { assertSyntheticAllowed } from "./synthetic-guard.js";

// An APPROXIMATION of production's server-side scorer, and labelled as one.
//
// Production's scorer differs from the client formula — its own 150-parcel feed
// proves it: catalyst-free parcels score up to 98, which the client model cannot
// produce. What follows is a least-squares fit of the production scorer over
// that feed. It reproduces the sampled parcels closely; it cannot guarantee an
// identical score for a parcel that was not in the sample, because the rule
// itself was never recovered.
//
// That distinction has to reach the API. Every parcel therefore carries
// scoreValueType:"modeled estimate" and a scoreBasis naming the fit, so the
// score is never presented as the original's figure or as a recorded fact.
// It is a screening rank, and it says so.
// The fit itself now lives in server/live.js as devScoreFromReal, so the parcel
// strip, the ZIP inventory and the territory drill-down cannot report different
// scores for the same lot — which the original never does. This wrapper is kept
// so the name and the reasoning stay attached to the endpoint that needs them.
function productionOpportunityScore(p) {
  return devScoreFromReal(p);
}

const BOROUGHS = ["MN", "BX", "BK", "QN", "SI"];
const BORO_DIGIT = { MN: "1", BX: "2", BK: "3", QN: "4", SI: "5" };

// Production constants, byte-matched to the live API's responses.
const NEIGHBORHOOD_FALLBACK = "FiDi / Lower Manhattan";

// Which neighborhood a live parcel is actually in.
//
// THE DEFECT
// Every live parcel — Manhattan, Bronx, Brooklyn, Queens, Staten Island alike —
// was labelled NEIGHBORHOOD_FALLBACK, i.e. "FiDi / Lower Manhattan". A lot in
// Jamaica said FiDi. The neighborhood filter was then given an explicit bypass
// (`|| p.id.startsWith("LIVE-")`) so that every live parcel passed regardless of
// which neighborhood was requested — which hid the wrong labels by making the
// filter do nothing.
//
// THE RULE
// The eighteen curated neighborhood names are the vocabulary the UI filters on,
// and every one of them has real anchor coordinates in seed-parcels.js. A parcel
// takes the name of the nearest anchor IN ITS OWN BOROUGH, and only within
// MAX_ANCHOR_MI. Outside that, it takes its borough name rather than being
// assigned to a neighborhood it is not in: these are labels, and a wrong label
// is worse than a coarse one. Nothing here is invented — the anchors are
// coordinates already in this repository and the borough comes from the BBL.
const BORO_NAME_BY_DIGIT = { 1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island" };
const MAX_ANCHOR_MI = 1.75;
let anchorCache = null;

async function neighborhoodAnchors() {
  if (anchorCache) return anchorCache;
  const { SEED_PARCELS, BOROUGH_BY_NEIGHBORHOOD } = await import("./seed-parcels.js");
  const groups = new Map();
  for (const p of SEED_PARCELS) {
    if (!p.neighborhood || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (!groups.has(p.neighborhood)) groups.set(p.neighborhood, []);
    groups.get(p.neighborhood).push([p.lat, p.lng]);
  }
  anchorCache = [...groups].map(([name, pts]) => ({
    name,
    borough: BOROUGH_BY_NEIGHBORHOOD[name] ?? null,
    lat: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    lng: pts.reduce((s, p) => s + p[1], 0) / pts.length
  }));
  return anchorCache;
}

const MI_PER_DEG = 69.055;
function milesApart(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * MI_PER_DEG;
  const dLng = (lng2 - lng1) * MI_PER_DEG * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

export async function neighborhoodFor(lat, lng, bbl) {
  const borough = BORO_NAME_BY_DIGIT[Number(String(bbl ?? "")[0])] ?? null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return borough ?? NEIGHBORHOOD_FALLBACK;
  const anchors = await neighborhoodAnchors();
  const pool = borough ? anchors.filter((a) => a.borough === borough) : anchors;
  let best = null;
  for (const a of pool.length ? pool : anchors) {
    const mi = milesApart(lat, lng, a.lat, a.lng);
    if (!best || mi < best.mi) best = { mi, name: a.name };
  }
  if (best && best.mi <= MAX_ANCHOR_MI) return best.name;
  return borough ?? NEIGHBORHOOD_FALLBACK;
}
const OWNER_NOTE = "Owner of record per PLUTO; confirm in ACRIS.";
const NEXT_ACTION = "Pull live DOB / ACRIS / sales evidence in the dossier.";

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// Asset class and display category, both measured off the original.
//
// HOW THESE WERE DERIVED (2026-08-18, nycremarketintel.com through its gate)
// /api/opportunities?zips=…&assetClass=… was driven for every class on two ZIPs,
// then every returned BBL was looked up in PLUTO (Socrata 64uk-42ks) and the
// building class tabulated against what the original had labelled it:
//
//   ?assetClass=multifamily  11216 → 150 rows, classes {D:76, C:74}
//   ?assetClass=condo        11216 →  84 rows, classes {R:84}
//   ?assetClass=office       11216 →  18 rows, classes {O:18}
//   ?assetClass=hotels       11216 →   8 rows, classes {H:8}
//   ?assetClass=development  11216 →  18 rows, classes {V:18} (V0/V1)
//   ?assetClass=misc / retail      → the UNFILTERED list, i.e. a value outside
//                                    the five is ignored rather than matching
//                                    nothing
//
// So the parameter selects on the PLUTO building-class letter. It is NOT the
// display `category`: the multifamily answer contains 138 rows labelled
// "Multifamily Candidate" AND 12 labelled "Underbuilt Parcel". This router used
// to compare it against `category` directly, which no value can ever satisfy,
// so every filtered request answered [] where the original answered 150.
//
// The display category, tabulated over the same 150-row sample:
//
//   building class O                    → "Office-to-Residential Candidate" (9/9)
//   building class V / land use 11      → "Development Site"                (47/47)
//   building class C, D, R              → split, see below
//   E G H I K M N P W (everything else) → "Underbuilt Parcel"               (37/37)
//
// The C/D/R split is a clean threshold on how much of the envelope is built:
//   built/max FAR ratio for the 9 "Underbuilt Parcel" rows: 0.23 … 0.59
//   built/max FAR ratio for the 95 "Multifamily Candidate" rows: 0.61 … 2.60
// No sample lies between, so the boundary is 0.6 — the same constant the
// development lens in production-live-extra.js already uses.
const CLASS_LETTER = (bldgClass) => String(bldgClass ?? "").trim()[0]?.toUpperCase() ?? "";

export function assetClassOf(bldgClass) {
  const c = CLASS_LETTER(bldgClass);
  if (c === "C" || c === "D") return "multifamily";
  if (c === "R") return "condo";
  if (c === "O") return "office";
  if (c === "H") return "hotels";
  if (c === "V") return "development";
  return "";
}

// The `bldgclass like` predicate for each class, so a per-ZIP pull can ask the
// record for that class instead of hoping it falls out of a generic page.
export const ASSET_CLASS_SOQL = {
  multifamily: "(bldgclass like 'C%' or bldgclass like 'D%')",
  condo: "bldgclass like 'R%'",
  office: "bldgclass like 'O%'",
  hotels: "bldgclass like 'H%'",
  development: "bldgclass like 'V%'"
};

const UNDERBUILT_RATIO = 0.6;
// A low built/max ratio is necessary but NOT sufficient. Measured 2026-08-20 over
// 1,414 rows the original itself publishes (twelve ZIP+lens feeds), the ratio rule
// alone is wrong on 17 of them — every one a small lot the original still calls a
// Multifamily Candidate despite being well under 0.6:
//
//   1007530029  ratio 0.5800  unbuiltFarSf 3,649   R8B walk-up, 2,172 sf lot
//   4130750080  ratio 0.2800  unbuiltFarSf 4,593   R3A, 6,379 sf lot
//   5004210022  ratio 0.4400  unbuiltFarSf 4,410   R2,  7,875 sf lot
//
// Inside the band where both labels occur (0.44 <= ratio < 0.6, 159 rows) the two
// populations do not overlap on unused buildable area at all:
//
//   Underbuilt Parcel     146 rows   unbuiltFarSf  5,814 .. 1,133,513
//   Multifamily Candidate  13 rows   unbuiltFarSf  2,442 ..     4,870
//
// So the second condition is a floor on unbuiltFarSf, bracketed to (4,870, 5,000]
// — 5,000 reproduces every row, 5,500 does not (two rows carry between 5,000 and
// 5,500 and are Underbuilt). 5,000 is the round number at the top of the bracket.
//
//   ratio only                fit 1397/1414   holdout 842/842
//   ratio + unbuilt >= 5000   fit 1414/1414   holdout 842/842
//   ratio + unbuilt >= 5500   fit 1412/1414
//
// The holdout is eight ZIP+lens feeds (11215, 10025, 11235, 10462, 11375, 10309,
// 11106, 10467) that were not used to find the rule.
const UNDERBUILT_MIN_UNUSED_SF = 5000;
function categoryOf(bldgClass, landUse, builtFar, maxFar, unbuiltFarSf) {
  const c = CLASS_LETTER(bldgClass);
  if (c === "V" || landUse === "11") return "Development Site";
  if (c === "O") return "Office-to-Residential Candidate";
  if (c === "C" || c === "D" || c === "R") {
    const ratio = maxFar > 0 ? builtFar / maxFar : 1;
    return (ratio < UNDERBUILT_RATIO && Number(unbuiltFarSf) >= UNDERBUILT_MIN_UNUSED_SF)
      ? "Underbuilt Parcel"
      : "Multifamily Candidate";
  }
  return "Underbuilt Parcel";
}

function rowToParcel(r) {
  const bbl = String(r.bbl ?? "").replace(/\..*$/, "");
  const lotSf = num(r.lotarea);
  const far = num(r.builtfar);
  // facilfar counts. Measured against the original's published maxFar on 40
  // parcels of its own bare feed: max(residfar, commfar, facilfar) matched
  // 40/40, max(residfar, commfar) matched 11/40. It also decides `category`
  // and `unbuiltFarSf`, which matched 40/40 once facilfar was included.
  const maxFar = Math.max(num(r.residfar), num(r.commfar), num(r.facilfar));
  const unbuiltFarSf = Math.max(0, Math.round(lotSf * Math.max(0, maxFar - far)));
  const landUse = r.landuse ? String(parseInt(r.landuse, 10)) : "—";
  const category = categoryOf(r.bldgclass, landUse, far, maxFar, unbuiltFarSf);
  // risk is a pure function of the score, not of envelope share. Measured on
  // the original's own 150-item bare feed, with no exceptions:
  //   Elevated  score 30..69   (n=92)
  //   Moderate  score 71..84   (n=40)
  //   Low       score 85..98   (n=18)
  // Score 70 is unobserved in the sample, so the Moderate band is written as
  // >= 70 and that single boundary is the one part of this rule not measured.
  const adaptiveReuse = category === "Office-to-Residential Candidate";

  const parcel = {
    id: "LIVE-" + bbl,
    address: r.address ?? "—",
    neighborhood: NEIGHBORHOOD_FALLBACK,
    category,
    lat: num(r.latitude),
    lng: num(r.longitude),
    bbl,
    bin: "",
    block: num(r.block),
    lot: num(r.lot),
    zoning: r.zonedist1 ?? "—",
    landUse,
    lotSf,
    bldgSf: num(r.bldgarea),
    far,
    maxFar,
    yearBuilt: num(r.yearbuilt),
    floors: num(r.numfloors),
    owner: r.ownername ?? "",
    ownerNote: OWNER_NOTE,
    conversionFit: "N/A",
    risk: "Elevated",
    status: "Tracked",
    signals: ["PLUTO"],
    policyCatalysts: [],
    adaptiveReuse,
    riskFlags: [],
    nextAction: NEXT_ACTION,
    estLandPpbsf: 0,
    unbuiltFarSf,
    sourcedFact: true,
    zip: r.zipcode ?? "", // internal filter key; harmless extra field
    // Internal score input, stripped by opportunityContract() like `zip` and
    // `assetClass`. The recovered rule has a 10-point assessed-value term and
    // this parcel carried no assessTotal, so every opportunity came out exactly
    // ten low: 30 against the original's 30->20, 96->86, 95->86. assesstot is
    // already in OPP_SELECT; it simply never reached the scorer.
    assessTotal: num(r.assesstot),
    // What ?assetClass= selects on. Carried on the row rather than recomputed at
    // the filter because the building class it is derived from is not part of
    // the original's response and must not be added to it.
    assetClass: assetClassOf(r.bldgclass)
  };
  parcel.opportunityScore = productionOpportunityScore(parcel);
  parcel.risk = parcel.opportunityScore >= 85 ? "Low" : parcel.opportunityScore >= 70 ? "Moderate" : "Elevated";
  parcel.scoreValueType = "modeled estimate";
  parcel.scoreBasis =
    "Least-squares fit of the original site's server-side opportunity scorer over its published 150-parcel feed. " +
    "Inputs are published PLUTO fields (envelope share, unused FAR, age, vacancy, adaptive-reuse eligibility). " +
    "It tracks the sampled parcels closely but is not the recovered rule, so an unsampled parcel may score differently there. " +
    "Use it to rank, not as a figure to quote.";
  // Verbatim from the original, measured on its bare feed:
  //   "Modeled development score 30. Confirm ownership intent, debt and any
  //    active filings in the dossier."
  // It carries no parenthetical. The "(modeled estimate, not a recorded
  // figure)" qualifier this used to append is not in the specification.
  parcel.thesis = `Modeled development score ${parcel.opportunityScore}.${unbuiltFarSf > 0 ? ` ~${unbuiltFarSf.toLocaleString("en-US")} sf unused FAR.` : ""} Confirm ownership intent, debt and any active filings in the dossier.`;
  return parcel;
}

let cache = { at: 0, list: null };

export async function liveOpportunities() {
  if (cache.list && Date.now() - cache.at < 6 * 3600e3) return cache.list;
  // Underbuilt giant lots dominate (they carry the high development scores,
  // like production's list); a handful of trophy buildings per borough round
  // out the low-score tail exactly as the live site's mix does.
  const pulls = await Promise.all(BOROUGHS.flatMap((b) => [
    plutoTopByBorough(b, { limit: 30, order: "lotarea DESC", extraWhere: "residfar > 0" }).catch(() => ({ live: false, rows: [] })),
    plutoTopByBorough(b, { limit: 8, order: "bldgarea DESC" }).catch(() => ({ live: false, rows: [] }))
  ]));
  if (!pulls.some((p) => p.live && p.rows?.length)) return null;
  const seen = new Set();
  const list = [];
  for (const p of pulls) {
    for (const r of p.rows ?? []) {
      const parcel = rowToParcel(r);
      if (!parcel.bbl || seen.has(parcel.bbl) || !parcel.lat || !parcel.lng) continue;
      seen.add(parcel.bbl);
      list.push(parcel);
    }
  }
  const capped = list.slice(0, 150);
  // Real neighborhoods, borough-constrained. Resolved here rather than inside
  // rowToParcel so the anchor table is loaded once per batch instead of once
  // per parcel.
  await resolveNeighborhoods(capped);
  cache = { at: Date.now(), list: capped };
  return capped;
}

// Curated fallback: the platform's own authored universe already carries the
// full parcel vocabulary — the strip keeps rendering even if every Socrata
// pull fails.
// The curated universe carries seeded owners and authored scores. It is the
// offline and demo source, never a production answer — see synthetic-guard.js.
export function curatedAsParcels() {
  assertSyntheticAllowed("server/seed-parcels.js");
  return SEED_PARCELS;
}

// Map raw PLUTO-vocabulary rows (Socrata or the PostGIS parcel store) into the
// production parcel contract with the platform's own scoring.
export function plutoRowsToParcels(rows) {
  const seen = new Set();
  const list = [];
  for (const r of rows ?? []) {
    const parcel = rowToParcel(r);
    if (!parcel.bbl || seen.has(parcel.bbl) || !parcel.lat || !parcel.lng) continue;
    seen.add(parcel.bbl);
    list.push(parcel);
  }
  return list.slice(0, 150);
}

// Replace the placeholder neighborhood on a batch of parcels with the real one.
// Mutates in place and returns the same array, so callers can await it or not.
export async function resolveNeighborhoods(parcels) {
  for (const p of parcels ?? []) {
    p.neighborhood = await neighborhoodFor(p.lat, p.lng, p.bbl);
  }
  return parcels;
}
