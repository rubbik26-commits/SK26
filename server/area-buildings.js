// GET /api/area-buildings — production PLUTO area contract plus transparent
// seller-propensity evidence. Property values are never guessed from a failed
// source: count/detail are both required, and missing permit history is unknown,
// not zero activity.
import { soql, escSoql } from "./adapters/socrata.js";
import { DS } from "./adapters/nyc.js";
import { devScoreFromReal } from "./live.js";

const PLUTO = DS.pluto;
const DOB_PERMITS = DS.dobPermits;
const NOW_YEAR = 2026;

const SORT_ORDER = {
  propensity: "yearbuilt ASC",
  yearbuilt: "yearbuilt ASC",
  score: "lotarea DESC",
  lotarea: "lotarea DESC",
  assesstot: "assesstot DESC",
  unitsres: "unitsres DESC"
};
const IN_MEMORY_SORT = new Set(["propensity", "score"]);

const CLASS_PREDICATE = {
  multifamily: "(bldgclass like 'C%' or bldgclass like 'D%')",
  condo: "bldgclass like 'R%'",
  office: "bldgclass like 'O%'",
  hotels: "bldgclass like 'H%'",
  development: "(bldgclass like 'V%' or bldgclass like 'Z%')",
  other: "not (bldgclass like 'C%' or bldgclass like 'D%' or bldgclass like 'R%' or bldgclass like 'O%' or bldgclass like 'H%' or bldgclass like 'V%')"
};

const GOV_RE = /\bCITY OF\b|\bNYC\b|NEW YORK CITY|STATE OF NEW ?YORK|\bNY STATE\b|\bNYS\b|UNITED STATES|\bFEDERAL\b|DEPARTMENT OF|DEPT OF|\bDEPT\b|\bAUTHORITY\b|\bAUTH\b|DORMITORY|METROPOLITAN TRANS|\bMTA\b|\bTRANSIT\b|PORT AUTH|HOUSING AUTH|\bNYCHA\b|TRIBOROUGH|\bRAILROAD\b|\bAMTRAK\b|CON ?ED|CONSOLIDATED EDISON|NATIONAL GRID|BOARD OF ED|PUBLIC LIBRARY|POST OFFICE|\bSANITATION\b|ECONOMIC DEVELOPMENT|\bEDC\b|PUBLIC SCHOOL|\bU\.?S\.?A\.?\b/;
const INSTITUTIONAL_RE = /LLC|L\.L|\bINC\b|CORP|\bLP\b|L\.P|REIT|ASSOC|PARTNER|REALTY|MANAGEMENT|MGMT|HOLDING|TRUST|FUND|PROPERT|GROUP|CHURCH|HOSPITAL|HOUSING/;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const groups = (n) => Number(n).toLocaleString("en-US");

export function parseParams(query) {
  const zips = [];
  // The original production site accepts the singular ?zip= as well as ?zips=
  // (verified 2026-08-17: ?zip=11216 answers 200 there and 400 here before
  // this line). Accept both; ?zips= wins when both are supplied.
  for (const raw of String(query.zips ?? query.zip ?? "").split(",")) {
    const z = raw.trim();
    if (/^\d{5}$/.test(z) && !zips.includes(z)) zips.push(z);
  }
  const page = Math.max(0, parseInt(query.page, 10) || 0);
  const pageSize = Math.min(1000, Math.max(1, parseInt(query.pageSize, 10) || 200));
  const requested = String(query.sort ?? "");
  const sort = Object.prototype.hasOwnProperty.call(SORT_ORDER, requested) ? requested : "score";
  const cls = String(query.class ?? "");
  return { zips, page, pageSize, sort, cls: Object.prototype.hasOwnProperty.call(CLASS_PREDICATE, cls) ? cls : null };
}

function whereClause(zips, cls) {
  const list = zips.map((z) => `'${escSoql(z)}'`).join(",");
  const base = `zipcode in (${list})`;
  return cls ? `${base} and ${CLASS_PREDICATE[cls]}` : base;
}

function sourceUrl(dataset, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  return `https://data.cityofnewyork.us/resource/${dataset}.json?${qs}`;
}

function project(raw) {
  const b = {};
  const set = (key, value) => { if (value != null) b[key] = value; };

  const borocode = String(raw.borocode ?? "");
  const block = raw.block == null ? null : String(raw.block);
  const lot = raw.lot == null ? null : String(raw.lot);
  if (borocode && block != null && lot != null) b.bbl = borocode + block.padStart(5, "0") + lot.padStart(4, "0");
  set("borough", borocode || null);
  set("block", block);
  set("lot", lot);
  b.address = raw.address == null ? "—" : String(raw.address);
  set("zip", raw.zipcode == null ? null : String(raw.zipcode));
  const lat = num(raw.latitude), lng = num(raw.longitude);
  if (lat != null && lng != null) { b.lat = lat; b.lng = lng; }
  set("bldgClass", raw.bldgclass == null ? null : String(raw.bldgclass));
  set("landUse", raw.landuse == null ? null : String(raw.landuse));
  set("owner", raw.ownername == null ? null : String(raw.ownername));
  set("zoning", raw.zonedist1 == null ? null : String(raw.zonedist1));
  // overlay BEFORE specialDistrict. Measured 2026-08-19 on /api/address?q=350
  // 5th Avenue, lot 3053370069 — the only probed lot that carries both — the
  // original's key order is zoning, overlay, specialDistrict; the rebuild
  // emitted zoning, specialDistrict, overlay.
  set("overlay", raw.overlay1 == null ? null : String(raw.overlay1));
  set("specialDistrict", raw.spdist1 == null ? null : String(raw.spdist1));

  for (const [key, field] of [
    ["lotArea", "lotarea"], ["bldgArea", "bldgarea"], ["resArea", "resarea"],
    ["comArea", "comarea"], ["officeArea", "officearea"], ["retailArea", "retailarea"],
    ["numBldgs", "numbldgs"], ["numFloors", "numfloors"], ["unitsRes", "unitsres"],
    ["unitsTotal", "unitstotal"], ["yearBuilt", "yearbuilt"], ["yearAltered", "yearalter1"],
    ["builtFar", "builtfar"]
  ]) set(key, raw[field] == null ? null : num(raw[field]));

  b.residFar = num(raw.residfar) ?? 0;
  b.commFar = num(raw.commfar) ?? 0;
  b.facilFar = num(raw.facilfar) ?? 0;

  const maxFar = Math.max(b.residFar, b.commFar, b.facilFar);
  if (maxFar > 0) {
    b.maxFar = maxFar;
    b.unusedFar = Math.max(0, maxFar - (b.builtFar ?? 0));
    if (b.lotArea != null) b.unusedFarSf = Math.round(b.unusedFar * b.lotArea);
  }

  for (const [key, field] of [
    ["assessLand", "assessland"], ["assessTotal", "assesstot"],
    ["lotFront", "lotfront"], ["lotDepth", "lotdepth"]
  ]) set(key, raw[field] == null ? null : num(raw[field]));

  b.score = developmentScore(b);
  b.raw = raw;
  return b;
}

// The original serves ONE score per lot: /api/area-buildings, /api/address,
// /api/territory and /api/opportunities all answer the same number for the same
// BBL. This codebase had TWO scorers, so the inventory list and the territory
// drill-down disagreed about the same building. Both are now the single
// recovered rule in server/live.js — see the derivation there. Verified
// 2000/2000 exact against the original's own /api/area-buildings scores across
// ten ZIPs; the fit this replaced reproduced 280 of the same 2000.
export function developmentScore(b) {
  return devScoreFromReal(b);
}

export function propensityFor(b, permitCount) {
  const owner = String(b.owner ?? "").toUpperCase();
  if (owner && GOV_RE.test(owner)) return { propensity: 0, why: null };

  const comps = [];
  const age = b.yearBuilt && b.yearBuilt > 1800 ? NOW_YEAR - b.yearBuilt : null;
  if (age != null && age >= 90) comps.push([14, `built ${b.yearBuilt} (${age} yrs old)`]);
  else if (age != null && age >= 60) comps.push([7, `built ${b.yearBuilt}`]);

  const maxFar = b.maxFar ?? 0;
  const unusedFar = maxFar > 0 ? Math.max(0, maxFar - (b.builtFar ?? 0)) : 0;
  const unusedSf = b.lotArea ? Math.round(unusedFar * b.lotArea) : 0;
  const envShare = maxFar > 0 ? unusedFar / maxFar : 0;
  if (unusedSf > 50000 && envShare > 0.5) comps.push([24, `${groups(unusedSf)} sf unused FAR (${Math.round(envShare * 100)}% of envelope unbuilt)`]);
  else if (unusedSf > 15000 && envShare > 0.4) comps.push([13, `${groups(unusedSf)} sf unused FAR`]);

  if (b.assessLand && b.assessTotal && b.assessTotal > 0) {
    const share = b.assessLand / b.assessTotal;
    if (share >= 0.75) comps.push([12, `${Math.round(share * 100)}% of assessed value is land — value in the dirt`]);
  }

  const institutional = INSTITUTIONAL_RE.test(owner);
  if (owner && !institutional) comps.push([11, "individual owner of record — estate / generational-turnover potential"]);
  // Unknown permit history is not zero permit history. Only a successfully
  // resolved numeric zero earns the limited-reinvestment signal.
  //
  // `(permitCount ?? 0) === 0` scored a DOB outage as evidence: areaBuildings()
  // deliberately leaves permitCount ABSENT when the permit dataset is
  // unreachable — "rather than guessed at", as its own comment says — and `?? 0`
  // turned that absence into the number zero, awarding +6 for "no recent DOB
  // permits" to every building on the page. A source being down is not the same
  // fact as a building having no permits, and that sentence is printed to the
  // user as the reason for the score.
  const unevaluated = [];
  if (Number.isFinite(permitCount) && permitCount === 0 && (age == null || age > 40)) {
    comps.push([6, "no recent DOB permits — limited reinvestment"]);
  } else if (!Number.isFinite(permitCount) && (age == null || age > 40)) {
    // Reported rather than silently scored either way, so a reader can tell a
    // genuinely lower score from one that is missing a component.
    unevaluated.push("DOB permit activity — the permit dataset did not answer for this lot, so reinvestment history is not part of this score");
  }
  const units = b.unitsRes ?? 0;
  if (units >= 4 && units <= 30 && !institutional) comps.push([6, "4–30 unit walk-up — owner-operator scale"]);

  const propensity = Math.min(100, comps.reduce((sum, c) => sum + c[0], 0));
  return {
    propensity,
    why: comps.length ? comps[0][1] : null,
    ...(unevaluated.length ? { unevaluated } : {})
  };
}

export async function areaBuildings(query) {
  const { zips, page, pageSize, sort, cls } = parseParams(query);
  if (!zips.length) return { status: 400, body: { error: "Provide one or more 5-digit ZIP codes via ?zips=" } };

  const where = whereClause(zips, cls);
  const order = SORT_ORDER[sort];
  const offset = page * pageSize;
  const countParams = { $where: where, $select: "count(1) as n" };
  const pageParams = { $where: where, $order: order, $limit: pageSize, $offset: offset };

  const [countRes, pageRes] = await Promise.all([
    soql(PLUTO, countParams),
    soql(PLUTO, pageParams)
  ]);

  // A count and its detail page describe one logical result set. Returning 200
  // when either half failed produced contradictions such as “0 tax lots” beside
  // real building rows, or a valid count beside an empty failed page.
  if (!countRes.live || !pageRes.live) {
    return {
      status: 503,
      body: {
        provenance: "unavailable",
        error: "pluto_partial_failure",
        sources: [
          { id: "pluto_count", status: countRes.live ? "ok" : "error", error: countRes.error || null },
          { id: "pluto_page", status: pageRes.live ? "ok" : "error", error: pageRes.error || null }
        ]
      }
    };
  }

  const total = Number(countRes.rows?.[0]?.n ?? 0) || 0;
  const rows = pageRes.rows ?? [];
  const buildings = rows.map(project);
  const sources = [
    { id: "pluto_count", label: "PLUTO lot count", endpoint: PLUTO, query: sourceUrl(PLUTO, countParams), status: "ok", count: total },
    { id: "pluto_page", label: "PLUTO Tax Lots (full detail)", endpoint: PLUTO, query: sourceUrl(PLUTO, pageParams), status: rows.length ? "ok" : "empty", count: rows.length }
  ];

  if (buildings.length) {
    const bbls = buildings.map((b) => b.bbl).filter(Boolean);
    const permitParams = {
      $where: `bbl in (${bbls.map((x) => `'${escSoql(x)}'`).join(",")})`,
      $select: "bbl,count(1) as n",
      $group: "bbl",
      $limit: 50000
    };
    const permitRes = await soql(DOB_PERMITS, permitParams, { timeoutMs: 25000 });
    const byBbl = new Map();
    for (const r of permitRes.rows ?? []) byBbl.set(String(r.bbl), Number(r.n) || 0);
    if (permitRes.live) for (const b of buildings) b.permitCount = byBbl.get(b.bbl) ?? 0;
    sources.push({
      id: "dob_permits_area", label: "DOB Permit activity (by lot)", endpoint: DOB_PERMITS,
      query: sourceUrl(DOB_PERMITS, permitParams),
      status: permitRes.live ? "ok" : "error",
      count: permitRes.live ? byBbl.size : 0,
      ...(permitRes.live ? {} : { error: permitRes.error || "DOB Permit Issuance unavailable" })
    });
  }

  for (const b of buildings) {
    const { propensity, why, unevaluated } = propensityFor(b, b.permitCount);
    b.propensity = propensity;
    if (why != null) b.propensityWhy = why;
    // Carried onto the building so a reader can tell a genuinely lower score
    // from one that is missing a component. Present only when a component
    // could not be evaluated, so the common case is byte-identical.
    if (unevaluated) b.propensityUnevaluated = unevaluated;
  }

  if (IN_MEMORY_SORT.has(sort)) {
    const key = sort === "propensity" ? "propensity" : "score";
    buildings.sort((a, z) => (z[key] ?? 0) - (a[key] ?? 0));
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const coverage = `${groups(total)} tax lots in ZIP ${zips.join(", ")}. Showing ${buildings.length} (page ${page + 1} of ${pages}). Every lot carries full PLUTO detail + a modeled development score; click any building for live DOB / ACRIS / sales evidence.`;

  return {
    status: 200,
    body: {
      zips,
      fetchedAt: new Date().toISOString(),
      page,
      pageSize,
      total,
      returned: buildings.length,
      sort,
      coverage,
      buildings,
      sources,
      ...(sources.some((s) => s.id === "dob_permits_area" && s.status === "error")
        ? { dataQuality: { permitHistory: "unavailable", note: "Seller propensity excludes the permit-activity component because DOB Permit Issuance was unavailable." } }
        : {})
    }
  };
}

export const PROPENSITY_THRESHOLD = 35;

// The original's /api/address answers the AREA envelope: the same enriched
// building rows (full PLUTO detail + modeled score + raw record + permit
// counts + propensity) wrapped in zips/page/sort keys (A/B diff 2026-08-17).
// Exported so the address handler produces rows through this exact pipeline
// instead of a thinner shape of its own.
export async function enrichPlutoRows(rawRows, { permits = true } = {}) {
  const buildings = (rawRows ?? []).map(project);
  // The original's ADDRESS rows carry score and raw but no permitCount and no
  // propensity (A/B diff), and its fresh search answers in ~0.6s — the DOB
  // permit round-trip below is an area-inventory cost the address path must
  // not pay. permits:false keeps the search at one PLUTO hop plus synchronous
  // scoring, exactly the original's shape and speed class.
  if (!permits) return buildings;
  if (buildings.length) {
    const bbls = buildings.map((b) => b.bbl).filter(Boolean);
    const permitRes = await soql(DOB_PERMITS, {
      $where: `bbl in (${bbls.map((x) => `'${escSoql(x)}'`).join(",")})`,
      $select: "bbl,count(1) as n", $group: "bbl", $limit: 50000
    }, { timeoutMs: 25000 });
    const byBbl = new Map();
    for (const r of permitRes.rows ?? []) byBbl.set(String(r.bbl), Number(r.n) || 0);
    if (permitRes.live) for (const b of buildings) b.permitCount = byBbl.get(b.bbl) ?? 0;
  }
  for (const b of buildings) {
    const { propensity, why, unevaluated } = propensityFor(b, b.permitCount);
    b.propensity = propensity;
    if (why != null) b.propensityWhy = why;
    if (unevaluated) b.propensityUnevaluated = unevaluated;
  }
  return buildings;
}
const BASE_SAMPLE = 500;

async function permitCountsFor(buildings) {
  const bbls = buildings.map((b) => b.bbl).filter(Boolean);
  if (!bbls.length) return { live: true, byBbl: new Map() };
  const r = await soql(DOB_PERMITS, {
    $where: `bbl in (${bbls.map((x) => `'${escSoql(x)}'`).join(",")})`,
    $select: "bbl,count(1) as n",
    $group: "bbl",
    $limit: 50000
  }, { timeoutMs: 25000 });
  if (!r.live) return { live: false, byBbl: new Map(), error: r.error };
  return { live: true, byBbl: new Map((r.rows || []).map((x) => [String(x.bbl), Number(x.n) || 0])) };
}

export async function propensityValidation(query) {
  const zips = [];
  for (const raw of String(query.zips ?? "").split(",")) {
    const z = raw.trim();
    if (/^\d{5}$/.test(z) && !zips.includes(z)) zips.push(z);
  }
  if (!zips.length) return { status: 400, body: { error: "Provide ?zips=" } };

  const where = whereClause(zips, null);
  const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const [baseRes, salesRes] = await Promise.all([
    soql(PLUTO, { $where: where, $order: "lotarea DESC", $limit: BASE_SAMPLE }),
    soql(DS.rollingSales, {
      $where: `zip_code in (${zips.map((z) => `'${escSoql(z)}'`).join(",")}) and sale_date > '${since}T00:00:00.000'`,
      $select: "borough,block,lot,sale_date,sale_price",
      $limit: 5000
    })
  ]);
  if (!baseRes.live || !salesRes.live) return { status: 503, body: null };

  const baseBuildings = (baseRes.rows ?? []).map(project);
  const permits = await permitCountsFor(baseBuildings);
  if (!permits.live) return { status: 503, body: null };

  const scored = baseBuildings.map((b) => ({
    bbl: b.bbl,
    propensity: propensityFor(b, permits.byBbl.get(b.bbl) ?? 0).propensity
  }));
  const byBbl = new Map(scored.map((s) => [s.bbl, s.propensity]));

  const soldBbls = new Set();
  for (const r of salesRes.rows ?? []) {
    const boro = String(r.borough ?? "").trim();
    const block = String(r.block ?? "").trim();
    const lot = String(r.lot ?? "").trim();
    if (!boro || !block || !lot) continue;
    soldBbls.add(boro + block.padStart(5, "0") + lot.padStart(4, "0"));
  }

  const soldScored = [...soldBbls].filter((b) => byBbl.has(b));
  const soldCount = soldBbls.size;
  const pct = (hit, n) => (n > 0 ? Math.round((hit / n) * 100) : 0);
  const soldHitPct = pct(soldScored.filter((b) => byBbl.get(b) >= PROPENSITY_THRESHOLD).length, soldScored.length);
  const baseHitPct = pct(scored.filter((s) => s.propensity >= PROPENSITY_THRESHOLD).length, scored.length);

  return {
    status: 200,
    body: {
      soldCount,
      soldHitPct,
      baseCount: scored.length,
      baseHitPct,
      lift: baseHitPct > 0 ? Math.round((soldHitPct / baseHitPct) * 100) / 100 : null,
      // Every score behind this lift includes the permit component: the guard
      // above returns 503 when permitCountsFor() is not live, so a backtest is
      // never published against a scoring rule the product does not use.
      threshold: PROPENSITY_THRESHOLD
    }
  };
}
