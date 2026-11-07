// Typed adapters over live NYC public records — the production data layer the
// original system ran on. Every function returns real records or an explicit
// { live:false } / empty result. Nothing here invents data.
//
// Datasets (verified against the live portal):
//   PLUTO                      64uk-42ks
//   ACRIS legals               8h5j-fqxa
//   ACRIS master               bnx9-e6tj
//   ACRIS parties              636b-3b5g
//   DOF rolling sales          usep-8jbt
//   DOB permit issuance        ipu4-2q9a
//   DOB NOW build filings      w9ak-ipjd
//   HPD violations             wvxf-dwi5
//   HPD registrations          tesw-yqqr
//   HPD registration contacts  feu5-w2e2
//   DOB/ECB violations         6bgk-3dad
//   311 service requests       erm2-nwe9
//   DOF assessments (PVAD)     8y4t-faws
//   Tax & water lien sale      9rz4-mjek
//   ZAP projects               hgx4-8ukb
//   Building footprints / subway stations / LL84 — resolved via catalog.
import { soql, soqlAll, resolveDataset, escSoql } from "./socrata.js";

export const DS = {
  pluto: "64uk-42ks",
  acrisLegals: "8h5j-fqxa",
  acrisMaster: "bnx9-e6tj",
  acrisParties: "636b-3b5g",
  rollingSales: "usep-8jbt",
  dobPermits: "ipu4-2q9a",
  dobNow: "w9ak-ipjd",
  hpdViolations: "wvxf-dwi5",
  hpdRegistrations: "tesw-yqqr",
  hpdContacts: "feu5-w2e2",
  ecb: "6bgk-3dad",
  s311: "erm2-nwe9",
  taxRates: "7zb8-7bpk",   // Property Tax Rates by Tax Class (adopted, all classes, all years)
  pvad: "8y4t-faws",
  lienSale: "9rz4-mjek",
  zap: "hgx4-8ukb",
  // ACRIS Document Control Codes — the City's own mapping from the four- or
  // five-character doc_type on a recorded instrument to its description
  // ("MTGE" → "MORTGAGE"). 126 rows, effectively static.
  acrisDocTypes: "7isb-wh4c"
};

// Plain-English label for an ACRIS document type.
//
// The dossier's debt block shows this: the original answers docTypeLabel
// "Mortgage" for docType "MTGE" where this codebase echoed the raw code twice.
// Read from the published control-code table rather than hand-written, so a
// code this file has never seen still resolves. The table is cached for a day;
// until the first successful read, and for any code the table does not carry,
// the raw code is returned rather than an invented expansion.
let docTypeTable = null;
export async function loadAcrisDocTypes() {
  if (docTypeTable) return docTypeTable;
  const r = await soql(DS.acrisDocTypes, { $limit: 500 }, { ttlMs: 24 * 3600e3 }).catch(() => ({ live: false, rows: [] }));
  if (!r.live) return null;
  const map = new Map();
  for (const row of r.rows ?? []) {
    const code = String(row.doc__type ?? row.doc_type ?? "").trim();
    const desc = String(row.doc__type_description ?? row.doc_type_description ?? "").trim();
    if (code && desc) map.set(code.toUpperCase(), titleCase(desc));
  }
  if (map.size) docTypeTable = map;
  return docTypeTable;
}
function titleCase(s) {
  return String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
export function acrisDocTypeLabel(code) {
  const key = String(code ?? "").trim().toUpperCase();
  if (!key) return null;
  return docTypeTable?.get(key) ?? code;
}

const BORO_NAME = { 1: "MANHATTAN", 2: "BRONX", 3: "BROOKLYN", 4: "QUEENS", 5: "STATEN ISLAND" };
const BORO_ABBR = { 1: "MN", 2: "BX", 3: "BK", 4: "QN", 5: "SI" };

export function parseBbl(bbl) {
  const digits = String(bbl ?? "").replace(/[^0-9]/g, "");
  if (digits.length !== 10) return null;
  const boro = Number(digits[0]);
  const block = parseInt(digits.slice(1, 6), 10);
  const lot = parseInt(digits.slice(6), 10);
  if (!boro || boro > 5 || !block || !lot) return null;
  return {
    digits, boro, block, lot,
    block5: String(block).padStart(5, "0"),
    lot4: String(lot).padStart(4, "0"),
    lot5: String(lot).padStart(5, "0"),
    plutoBbl: `${digits}.00000000`,
    boroName: BORO_NAME[boro], boroAbbr: BORO_ABBR[boro]
  };
}

const PLUTO_FIELDS = [
  "bbl", "borough", "block", "lot", "address", "zipcode", "ownername", "zonedist1", "splitzone",
  "bldgclass", "landuse", "lotarea", "bldgarea", "comarea", "resarea", "officearea",
  "retailarea", "numbldgs", "numfloors", "unitsres", "unitstotal", "yearbuilt", "yearalter1",
  "yearalter2", "builtfar", "residfar", "commfar", "facilfar", "assessland", "assesstot",
  "exempttot", "lotfront", "lotdepth", "latitude", "longitude",
  // Read by the lot-at enrichment (server/routes-bundle.js) so a resolved lot's
  // dossier carries the landmark designation, limited-height district, historic
  // district and E-designation the original's PostGIS-backed lot-at returns.
  // These are selected, not projected into the shared building shape, so the
  // area/opportunities endpoints are unaffected.
  "landmark", "histdist", "ltdheight", "edesignum"
].join(",");

// Map a raw PLUTO row into the building shape the whole frontend consumes.
export function plutoRowToBuilding(r) {
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const bbl = String(r.bbl ?? "").replace(/\..*$/, "");
  // facilfar counts. The original publishes maxFar 4.8 for BBL 3012200047 and
  // 3012080001 — lots whose residfar is 2.43, commfar 0 and facilfar 4.8 —
  // together with unusedFar 0.5699999999999994 and 2.01, which are 4.8 minus
  // builtfar. Dropping facilfar understated the envelope on every
  // community-facility lot and, once the recovered development score started
  // reading maxFar, understated the score with it: those two lots came out 34
  // and 30 against the original's 39 and 49. Measured 2026-08-19 on
  // /api/territory?zips=11216&assetClass=multifamily.
  const maxFar = Math.max(num(r.residfar), num(r.commfar), num(r.facilfar));
  const builtFar = num(r.builtfar);
  const lotArea = num(r.lotarea);
  const unusedFar = Math.max(0, (maxFar || 0) - builtFar);
  return {
    bbl,
    address: r.address ?? "",
    borough: { MN: "Manhattan", BX: "Bronx", BK: "Brooklyn", QN: "Queens", SI: "Staten Island" }[r.borough] ?? r.borough,
    block: parseInt(String(bbl).slice(1, 6), 10) || null,
    lot: parseInt(String(bbl).slice(6), 10) || null,
    zip: r.zipcode ?? "",
    lat: num(r.latitude) || null,
    lng: num(r.longitude) || null,
    bin: "",
    bldgClass: r.bldgclass ?? "",
    // Unpadded, because that is what the original site returns and the frontend
    // was compiled against: /api/asset-history?bbl=1008350041 answers
    // pluto.landUse "5" there and answered "05" here. PLUTO ships the code
    // zero-padded ("05"), so padStart looked like the tidier choice, but it is a
    // different string and anything comparing the two disagrees.
    landUse: r.landuse === null || r.landuse === undefined || r.landuse === ""
      ? ""
      : String(Number(r.landuse) || r.landuse),
    zoning: r.zonedist1 ?? "",
    overlay: "",
    specialDistrict: "",
    lotArea, bldgArea: num(r.bldgarea),
    resArea: num(r.resarea), comArea: num(r.comarea),
    officeArea: num(r.officearea), retailArea: num(r.retailarea),
    numBldgs: num(r.numbldgs) || 1, numFloors: num(r.numfloors),
    unitsRes: num(r.unitsres), unitsTotal: num(r.unitstotal),
    yearBuilt: num(r.yearbuilt), yearAltered: num(r.yearalter1) || num(r.yearalter2) || 0,
    // Both alteration years kept separately as well. `yearAltered` collapses them
    // to "the most recent one that exists", which is what the scoring wants, but
    // the dossier reports them as two distinct PLUTO fields and was emitting a
    // hard-coded null for the second.
    yearAlter1: num(r.yearalter1), yearAlter2: num(r.yearalter2),
    // Exemptions are already selected in PLUTO_FIELDS and were being dropped on
    // the floor here, which is why assessment.exemptTotal answered null.
    exemptTotal: num(r.exempttot),
    builtFar, residFar: num(r.residfar), commFar: num(r.commfar), facilFar: num(r.facilfar),
    maxFar, unusedFar: Math.round(unusedFar * 100) / 100,
    unusedFarSf: Math.round(unusedFar * lotArea),
    assessLand: num(r.assessland), assessTotal: num(r.assesstot),
    marketValue: null, // DOF full market value comes from the assessment roll, not PLUTO
    lotFront: num(r.lotfront), lotDepth: num(r.lotdepth),
    permitCount: null,
    owner: r.ownername ?? "",
    mailAddress: "",
    landmark: null, histDist: null,
    eDesig: null, splitZone: r.splitzone === "Y", ltdHeight: "",
    provenance: "live"
  };
}

export async function plutoByBbl(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [], error: "bad bbl" };
  return soql(DS.pluto, { $select: PLUTO_FIELDS, $where: `bbl='${p.digits}.00000000'`, $limit: 1 });
}

export async function plutoSearchAddress(q, boroAbbr = null) {
  const text = escSoql(String(q).toUpperCase().replace(/\s+/g, " ").trim());
  const where = [`upper(address) like '${text}%'`];
  if (boroAbbr) where.push(`borough='${boroAbbr}'`);
  return soql(DS.pluto, { $select: PLUTO_FIELDS, $where: where.join(" AND "), $limit: 12, $order: "address" });
}

// MapPLUTO carries condo-billing “ghost” lots whose attribute columns are all
// null; on `$order=… DESC` Socrata sorts those nulls FIRST, so unguarded area
// queries lead with skeleton rows (blank address/owner, zero areas). Real tax
// lots always carry bldgclass — require it, plus the order column itself.
const REAL_LOT = "bldgclass IS NOT NULL";
const orderGuard = (order) => {
  const col = String(order ?? "").trim().split(/\s+/)[0];
  if (!col) return "";
  return col === "yearbuilt" ? ` AND yearbuilt IS NOT NULL AND yearbuilt > 0` : ` AND ${col} IS NOT NULL`;
};

// extraWhere is an additional SoQL predicate ANDed onto the ZIP filter. It
// exists so /api/opportunities can ask the record for one building class
// directly — a generic page ordered by building area never contains a vacant
// (V-class) lot, which is exactly the class ?assetClass=development selects.
// Callers pass a fixed literal from ASSET_CLASS_SOQL, never user input.
export async function plutoByZips(zips, { limit = 320, offset = 0, order = "bldgarea DESC", extraWhere = "" } = {}) {
  const list = zips.map((z) => `'${escSoql(z)}'`).join(",");
  return soql(DS.pluto, { $select: PLUTO_FIELDS, $where: `zipcode in(${list}) AND ${REAL_LOT}${orderGuard(order)}${extraWhere ? ` AND ${extraWhere}` : ""}`, $limit: limit, $offset: offset, $order: order });
}

export async function plutoCountByZips(zips) {
  const list = zips.map((z) => `'${escSoql(z)}'`).join(",");
  const r = await soql(DS.pluto, { $select: "count(bbl) as n", $where: `zipcode in(${list}) AND ${REAL_LOT}` });
  return { ...r, count: r.rows?.[0]?.n ? parseInt(r.rows[0].n, 10) : 0 };
}

export async function plutoBbox(minLat, minLng, maxLat, maxLng, limit = 400) {
  const where = `latitude between ${minLat} and ${maxLat} AND longitude between ${minLng} and ${maxLng} AND ${REAL_LOT}`;
  return soql(DS.pluto, { $select: PLUTO_FIELDS, $where: where, $limit: limit });
}

// The same box, exhausted rather than capped.
//
// plutoBbox takes a row limit and Socrata answers with an arbitrary page of
// that size, in its own internal order. That is fine where the caller wants a
// sample, and wrong wherever the caller then ranks the rows: a "nearest lots"
// query capped at 120 rows over a Bed-Stuy box that holds 500 lots ranks 120
// arbitrary lots and calls the closest of those the nearest. Measured on
// /api/nearby?lat=40.6870&lng=-73.9440 before this change: the rebuild's
// closest lot was 154 ft away while the original's was 75 ft, and 20 of the 24
// lots it returned were not the original's.
//
// `complete` is the caller's proof that nothing was dropped; a caller that
// ranks rows must refuse rather than rank a truncated pool.
export async function plutoBboxAll(minLat, minLng, maxLat, maxLng, { maxRows = 5000 } = {}) {
  // No REAL_LOT here. plutoBbox drops every lot whose bldgclass is null, and
  // the original does not: /api/nearby?lat=40.7282&lng=-73.9942 returns BBL
  // 1005310016 as {"bbl":"1005310016","address":"—","distanceFt":154,…}, a
  // PLUTO row that carries nothing but bbl, latitude and longitude. Filtering
  // it out silently removed a real tax lot 154 ft from the point.
  const where = `latitude between ${minLat} and ${maxLat} AND longitude between ${minLng} and ${maxLng}`;
  // :id, Socrata's internal row id, not bbl. Paging needs *an* order or rows
  // repeat and skip between pages, but the order also survives into any stable
  // sort the caller applies afterwards, so it decides how ties break. Measured
  // at Bay Ridge (40.6413,-74.0776), where BBL 5000160103 and 5000160041 both
  // round to 364 ft: the original lists 103 first, :id ASC lists 103 first
  // (index 69 vs 73) and bbl ASC lists 041 first. :id ASC is also the order an
  // unordered query returns, so it is stable without changing the answer.
  return soqlAll(DS.pluto, { $select: PLUTO_FIELDS, $where: where, $order: ":id ASC" }, {
    pageSize: 1000, maxRows, timeoutMs: 30000, retries: 2
  });
}

// Borough-wide pull used by the live opportunities generator: the city's
// biggest envelopes per borough (largest buildings + largest lots).
export async function plutoTopByBorough(boroAbbr, { limit = 40, order = "lotarea DESC", extraWhere = "" } = {}) {
  return soql(DS.pluto, {
    $select: PLUTO_FIELDS,
    $where: `borough='${escSoql(boroAbbr)}' AND ${REAL_LOT}${orderGuard(order)}${extraWhere ? ` AND ${extraWhere}` : ""}`,
    $limit: limit, $order: order
  }, { ttlMs: 6 * 3600e3 });
}

// ---------------------------------------------------------------- ACRIS
const classifyDoc = (t) => {
  const s = String(t ?? "").toUpperCase();
  if (/SAT|SATISFACTION|RELEASE/.test(s)) return "satisfaction";
  if (/MTGE|MORTGAGE|MTG/.test(s)) return "mortgage";
  if (/ASST|ASSIGNMENT/.test(s)) return "assignment";
  if (/AGMT|CONSOLIDAT|SPREADER|MODIFICATION/.test(s)) return "agreement";
  if (/DEED/.test(s)) return "deed";
  return "other";
};

export async function acrisByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, deeds: [], mortgages: [], all: [], error: "bad bbl" };
  const legals = await soql(DS.acrisLegals, {
    $select: "document_id",
    $where: `borough='${p.boro}' AND block='${p.block}' AND lot='${p.lot}'`,
    $limit: 120
  });
  if (!legals.live) return { live: false, deeds: [], mortgages: [], all: [], error: legals.error };
  const ids = [...new Set(legals.rows.map((r) => r.document_id))];
  if (!ids.length) return { live: true, deeds: [], mortgages: [], all: [], parties: {} };

  const chunks = [];
  for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
  const master = [];
  for (const chunk of chunks) {
    const inList = chunk.map((d) => `'${escSoql(d)}'`).join(",");
    const m = await soql(DS.acrisMaster, {
      $select: "document_id,doc_type,document_date,document_amt,recorded_datetime,crfn",
      $where: `document_id in(${inList})`, $limit: 60
    }, { timeoutMs: 30000 });
    if (m.live) master.push(...m.rows);
  }
  master.sort((a, b) => String(b.recorded_datetime ?? "").localeCompare(String(a.recorded_datetime ?? "")));

  // Parties for the most recent deed + most recent mortgage (grantor/grantee,
  // borrower/lender) — one indexed query each.
  const withKind = master.map((m) => ({ ...m, kind: classifyDoc(m.doc_type) }));
  const keyDocs = [withKind.find((m) => m.kind === "deed"), withKind.find((m) => m.kind === "mortgage")].filter(Boolean);
  const parties = {};
  for (const doc of keyDocs) {
    const pr = await soql(DS.acrisParties, {
      $select: "document_id,party_type,name,address_1,address_2,city,state,zip",
      $where: `document_id='${escSoql(doc.document_id)}'`, $limit: 20
    }, { timeoutMs: 30000 });
    if (pr.live) parties[doc.document_id] = pr.rows;
  }
  return {
    live: true,
    all: withKind,
    deeds: withKind.filter((m) => m.kind === "deed"),
    mortgages: withKind.filter((m) => ["mortgage", "assignment", "agreement", "satisfaction"].includes(m.kind)),
    parties
  };
}

// ---------------------------------------------------------------- sales
const SALES_FIELDS = "sale_date,sale_price,address,borough,block,lot,building_class_at_present,building_class_category,gross_square_feet,land_square_feet,residential_units,total_units,zip_code";
export const parseSalesNum = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };

export async function rollingSalesByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  return soql(DS.rollingSales, {
    $select: SALES_FIELDS,
    $where: `borough='${p.boro}' AND block='${p.block}' AND lot='${p.lot}'`,
    $order: "sale_date DESC", $limit: 25
  });
}

export async function rollingSalesByZips(zips, { limit = 400, minPrice = 10000 } = {}) {
  const list = zips.map((z) => `'${escSoql(z)}'`).join(",");
  return soql(DS.rollingSales, {
    $select: SALES_FIELDS,
    $where: `zip_code in(${list}) AND sale_price > ${minPrice}`,
    $order: "sale_date DESC", $limit: limit
  });
}

// ---------------------------------------------------------------- DOB
// The permit pull the CONTACTS panel runs, which is not the one the permit
// history runs. The original queries this dataset by its single `bbl` column
// with NO $select, and that absence is load-bearing: with a projection Socrata
// renders issuance_date / filing_date as ISO ("2019-12-24"); without one, as
// the published MM/DD/YYYY ("12/24/2019"), which is the form the original's
// contact rows carry through verbatim. Its own published query:
//   ipu4-2q9a.json?bbl=<bbl>&$limit=50&$order=issuance_date DESC
export async function dobPermitContactsByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  return soql(DS.dobPermits, { bbl: p.digits, $limit: 50, $order: "issuance_date DESC" });
}

// New York State's corporate registry, on the State's own Socrata domain.
//
// This is where the dossier's "owner entities" come from on the original — it
// searches the registry for the owner's business name and returns the matching
// LLCs with their registered mailing addresses, county and DOS id. Its own
// published query:
//   data.ny.gov/resource/n9v6-gdp6.json
//     ?$where=upper(current_entity_name) like '%EMPIRE STATE BUILDING%'&$limit=6
// This deployment had been filling ownerEntities from HPD building
// registrations instead, which answer a different question and left the panel
// empty for every lot with no HPD registration.
export const NYS_DOS_DATASET = "n9v6-gdp6";
export async function nysDosByName(term, limit = 6) {
  const t = String(term ?? "").trim();
  if (!t) return { live: false, rows: [], skipped: true };
  return soql(NYS_DOS_DATASET, {
    $where: `upper(current_entity_name) like '%${escSoql(t.toUpperCase())}%'`,
    $limit: limit
  }, { domain: "https://data.ny.gov", ttlMs: 24 * 3600e3 });
}

export async function dobPermitsByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  return soql(DS.dobPermits, {
    $select: "issuance_date,job_type,permit_status,work_type,permittee_s_business_name,permittee_s_first_name,permittee_s_last_name,permittee_s_phone__,permittee_s_license__,owner_s_first_name,owner_s_last_name,owner_s_business_name,owner_s_business_type,filing_date,job__",
    $where: `borough='${escSoql(p.boroName)}' AND block='${p.block5}' AND lot='${p.lot5}'`,
    // 50, matching the original site's permit history depth. At 40 the dossier
    // silently truncated ten filings off the bottom of every busy parcel —
    // 1008350041 returns 50 rows there and returned 40 here — and a permit
    // history that stops early reads as "no earlier work" rather than "not
    // shown".
    $order: "issuance_date DESC", $limit: 50
  });
}

const DOBNOW_FIELDS = "job_filing_number,filing_date,job_type,filing_status,house_no,street_name,borough,block,lot,bin,applicant_first_name,applicant_last_name,owner_s_business_name";

export async function dobNowByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  return soql(DS.dobNow, {
    $select: DOBNOW_FIELDS,
    $where: `upper(borough)='${escSoql(p.boroName)}' AND block='${p.block}' AND lot='${p.lot}'`,
    $order: "filing_date DESC", $limit: 30
  });
}

// DOB NOW carries no `zip_code` column — the postal field is `postcode`, and
// `zip` is the APPLICANT's address. Filtering on zip_code made every query
// error out, which is why the development pipeline reported zeros for every
// area. Counts are verified against the production site for ZIP 11216 over 36
// months: 234 new buildings, 89 foundation jobs, 39 demolitions.
const DOBNOW_PIPELINE_FIELDS = [
  "job_filing_number", "filing_date", "job_type", "filing_status",
  "house_no", "street_name", "borough", "block", "lot", "bin", "bbl",
  "proposed_dwelling_units", "total_construction_floor_area",
  "applicant_business_name", "applicant_first_name", "applicant_last_name",
  "owner_first_name", "owner_last_name", "owner_s_business_name",
  "foundation_work_type_", "full_demolition_work_type_"
].join(",");

// A filing counts toward the development pipeline if it is a new building, a
// foundation job on an existing site, or a full demolition.
export const DOBNOW_PIPELINE_WHERE =
  "(job_type='New Building' or full_demolition_work_type_='YES' or foundation_work_type_='YES')";

export async function dobNowByZips(zips, monthsBack = 36) {
  const since = new Date(Date.now() - monthsBack * 30.4 * 864e5).toISOString().slice(0, 10);
  const list = zips.map((z) => `'${escSoql(z)}'`).join(",");
  return soql(DS.dobNow, {
    $select: DOBNOW_PIPELINE_FIELDS,
    $where: `postcode in(${list}) AND filing_date > '${since}' AND ${DOBNOW_PIPELINE_WHERE}`,
    $order: "filing_date DESC", $limit: 2000
  }, { timeoutMs: 40000 });
}

// Counts run over the whole window, not over the page of sites that is
// returned, so a 60-row site list still reports the true totals.
export async function dobNowPipelineCounts(zips, monthsBack = 36) {
  const since = new Date(Date.now() - monthsBack * 30.4 * 864e5).toISOString().slice(0, 10);
  const list = zips.map((z) => `'${escSoql(z)}'`).join(",");
  const base = `postcode in(${list}) AND filing_date > '${since}'`;
  const count = async (extra) => {
    const r = await soql(DS.dobNow, { $select: "count(1) as n", $where: `${base} AND ${extra}` }, { timeoutMs: 40000 });
    return r.live ? Number(r.rows?.[0]?.n ?? 0) || 0 : null;
  };
  const [newBuilding, foundation, demolition] = await Promise.all([
    count("job_type='New Building'"),
    count("foundation_work_type_='YES' AND job_type!='New Building'"),
    count("full_demolition_work_type_='YES'")
  ]);
  // Proposed units are text in the dataset, so they are summed client-side
  // over the new-building filings.
  const unitsRes = await soql(DS.dobNow, {
    $select: "proposed_dwelling_units",
    $where: `${base} AND job_type='New Building'`,
    $limit: 5000
  }, { timeoutMs: 40000 });
  const proposedUnits = unitsRes.live
    ? (unitsRes.rows ?? []).reduce((sum, r) => sum + (Number(r.proposed_dwelling_units) || 0), 0)
    : null;
  return { newBuilding, foundation, demolition, proposedUnits, live: newBuilding != null };
}

// ---------------------------------------------------------------- violations / distress
export async function hpdViolationsByBbl(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  return soql(DS.hpdViolations, {
    $select: "violationid,inspectiondate,currentstatus,violationstatus,class,novdescription",
    $where: `bbl='${p.digits}'`,
    $order: "inspectiondate DESC", $limit: 200
  });
}

export async function ecbByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  return soql(DS.ecb, {
    $select: "ecb_violation_number,ecb_violation_status,issue_date,severity,violation_type,penality_imposed,amount_paid,balance_due",
    $where: `boro='${p.boro}' AND block='${p.block5}' AND lot='${p.lot4}'`,
    $order: "issue_date DESC", $limit: 120
  });
}

// 311 keyed on the BBL, which is what the dataset actually joins on.
//
// s311ByAddress below matches `incident_address` against PLUTO's `address`
// string, and the two do not agree. For BBL 1008350041 PLUTO says
// "338 5 AVENUE"; 311 files the same building under something else, so the
// address query returned zero complaints for a Midtown tower and the distress
// panel showed a clean record. Checked against the dataset directly:
//
//   upper(incident_address)='338 5 AVENUE'      0
//   upper(incident_address)='338 FIFTH AVENUE'  0
//   upper(incident_address)='350 FIFTH AVENUE'  0
//   bbl='1008350041'                          125   ← and the original also says 125
//
// erm2-nwe9 carries a `bbl` column. Joining on it is exact, needs no string
// normalisation, and reproduces the original's count precisely.
export async function s311ByBbl(bbl, monthsBack = 12) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  const since = new Date(Date.now() - monthsBack * 30.4 * 864e5).toISOString().slice(0, 10);
  return soql(DS.s311, {
    $select: "created_date,complaint_type,descriptor,status,incident_address",
    $where: `bbl='${p.digits}' AND created_date > '${since}'`,
    $order: "created_date DESC", $limit: 200
  });
}

export async function s311ByAddress(address, zip, monthsBack = 12) {
  if (!address) return { live: false, rows: [] };
  const since = new Date(Date.now() - monthsBack * 30.4 * 864e5).toISOString().slice(0, 10);
  return soql(DS.s311, {
    $select: "created_date,complaint_type,descriptor,status",
    $where: `upper(incident_address)='${escSoql(String(address).toUpperCase())}'${zip ? ` AND incident_zip='${escSoql(zip)}'` : ""} AND created_date > '${since}'`,
    $order: "created_date DESC", $limit: 100
  });
}

// ---------------------------------------------------------------- contacts (real people/entities only)
export async function hpdContactsByBbl(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  // The NEWEST registration only. The original's own published query is
  //   tesw-yqqr.json?boroid=3&block=1137&lot=1
  //     &$select=registrationid, lastregistrationdate
  //     &$order=lastregistrationdate DESC&$limit=1
  // Reading four registrations mixed superseded filings into the contact list —
  // measured on BBL 3011370001, two rows where the original publishes one.
  const regs = await soql(DS.hpdRegistrations, {
    $select: "registrationid, lastregistrationdate",
    $where: `boroid='${p.boro}' AND block='${p.block}' AND lot='${p.lot}'`,
    $order: "lastregistrationdate DESC",
    $limit: 1
  });
  if (!regs.live || !regs.rows.length) return { live: regs.live, rows: [], error: regs.error };
  const ids = regs.rows.map((r) => `'${r.registrationid}'`).join(",");
  return soql(DS.hpdContacts, {
    $select: "type,corporationname,firstname,lastname,businesshousenumber,businessstreetname,businessapartment,businesscity,businessstate,businesszip",
    $where: `registrationid in(${ids})`, $limit: 40
  });
}

// ---------------------------------------------------------------- taxes
export async function taxHistoryByBbl(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  return soql(DS.pvad, {
    // `period` distinguishes the tentative and final roll snapshots, which this
    // dataset publishes as separate rows with identical valuations — without it
    // the caller cannot tell a second roll state from a second year, and every
    // year came out duplicated. The *extot columns carry the exemption totals
    // the dossier reports as exemptTotal.
    $select: "year,period,pymkttot,pymktland,pyacttot,pyactland,pyactextot,pytxbtot,pytaxclass,curmkttot,curacttot,curactextot,curtxbtot,curtaxclass",
    $where: `parid='${p.digits}'`,
    // Two rows per fiscal year, so 24 is a dozen years of history, not two.
    $order: "year DESC", $limit: 24
  });
}

// ---------------------------------------------------------------- tax rates
// The adopted class rates, from the City's own published table rather than a
// constant in this repository.
//
// The tax-history route carried a single hard-coded year (`ADOPTED_RATES` =
// {2026:{...}}), so every earlier year answered estTax:null — the original site
// shows a figure for all five years, and a blank tax column on a dossier reads
// as "no tax" rather than "not implemented". 7zb8-7bpk publishes every class for
// every year; its FY24/25 class 4 rate (10.762%) reproduces the original's 2025
// figure to the dollar, which is what confirmed the year mapping below.
//
// Year mapping: DOF's assessment `year` N is fiscal year (N-1)/N — DOF 2025 is
// the rate row "24/25". Rates are published as percentages and returned here as
// decimals so callers multiply directly.
export async function taxRatesByClass() {
  const r = await soql(DS.taxRates, { $select: "year,class_1,class_2,class_3,class_4", $limit: 60 },
    { ttlMs: 24 * 60 * 60 * 1000 });
  if (!r.live) return { live: false, byYear: {}, error: r.error };
  const byYear = {};
  for (const row of r.rows ?? []) {
    // "24/25" -> DOF year 2025. Two-digit years, so anchor on the century of the
    // second half rather than assuming 20xx forever.
    const m = String(row.year ?? "").match(/^(\d{2})\/(\d{2})$/);
    if (!m) continue;
    const yy = Number(m[2]);
    const dofYear = 2000 + yy;
    const pct = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n / 100 : null; };
    byYear[dofYear] = { 1: pct(row.class_1), 2: pct(row.class_2), 3: pct(row.class_3), 4: pct(row.class_4) };
  }
  return { live: true, byYear, source: "NYC DOF property tax rates by tax class (7zb8-7bpk)" };
}

// ---------------------------------------------------------------- lien sale
export async function lienSaleByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  return soql(DS.lienSale, {
    $select: "month,cycle,water_debt_only,tax_class_code",
    $where: `borough='${p.boro}' AND block='${p.block}' AND lot='${p.lot}'`,
    $order: "month DESC", $limit: 20
  });
}

// ---------------------------------------------------------------- ZAP
// ZAP project-bbl mapping. The dataset id is known and verified (2026-08-17:
// 2iga-a6mk answers with project_id + bbl columns). The old code resolved it
// through a catalog text search on every cold cache, and when that search
// returned nothing — which is what was happening on the deployed service —
// every ZAP pull reported live:false and /api/zap-live went dark. The catalog
// search remains only as a fallback if the pinned id ever 404s.
const ZAP_BBL_MAP = "2iga-a6mk";
export async function zapByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  let link = await soql(ZAP_BBL_MAP, { $where: `bbl='${p.digits}'`, $limit: 8 });
  if (!link.live) {
    const map = await resolveDataset("ZAP project bbls", (r) => /project.*bbl/i.test(r.name ?? ""));
    if (!map) return { live: false, rows: [], error: link.error || "zap bbl dataset unresolved" };
    link = await soql(map.id, { $where: `bbl='${p.digits}'`, $limit: 8 });
  }
  if (!link.live || !link.rows.length) return { live: link.live, rows: [], error: link.error };
  const ids = [...new Set(link.rows.map((r) => r.project_id))].map((x) => `'${escSoql(x)}'`).join(",");
  return soql(DS.zap, {
    $select: "project_id,project_name,project_status,project_brief,public_status,ulurp_non",
    $where: `project_id in(${ids})`, $limit: 8
  });
}

// ---------------------------------------------------------------- LL84 energy
export async function ll84ByBbl(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [] };
  // The consolidated current disclosure (2023-present) is the authoritative
  // vintage; the catalog-resolved older vintage remains only as a fallback.
  try {
    const { currentLl84ByBbl } = await import("./ll84-current.js");
    const current = await currentLl84ByBbl(p.digits);
    if (current.live && current.rows?.length) return { live: true, rows: current.rows, dataset: current.dataset };
  } catch { /* fall back to the catalog-resolved vintage */ }
  const ds = await resolveDataset("Energy and Water Data Disclosure Local Law 84 calendar year 2022",
    (r) => /energy and water data disclosure/i.test(r.name ?? ""));
  if (!ds) return { live: false, rows: [], error: "ll84 dataset unresolved" };
  const attempts = [
    `nyc_borough_block_and_lot='${p.digits}'`,
    `bbl_10_digits='${p.digits}'`,
    `bbl='${p.digits}'`,
    `nyc_borough_block_and_lot_bbl='${p.digits}'`
  ];
  for (const where of attempts) {
    const r = await soql(ds.id, { $where: where, $limit: 3 });
    if (r.live && r.rows.length) return { ...r, dataset: ds };
    if (r.live && !r.error) continue;
  }
  return { live: true, rows: [], dataset: ds };
}

// ---------------------------------------------------------------- transit
// MTA subway stations — published on the NY State portal (data.ny.gov).
export async function subwayStations() {
  const r = await soql("39hk-dx4f", {
    $select: "stop_name,daytime_routes,gtfs_latitude,gtfs_longitude",
    $limit: 800
  }, { ttlMs: 7 * 24 * 60 * 60 * 1000, domain: "https://data.ny.gov" });
  if (!r.live) return r;
  const rows = r.rows.map((s) => ({
    name: s.stop_name,
    lines: String(s.daytime_routes ?? "").trim().split(/\s+/).join(","),
    lat: parseFloat(s.gtfs_latitude), lng: parseFloat(s.gtfs_longitude)
  })).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && s.name);
  return { live: true, rows, dataset: { id: "39hk-dx4f", name: "MTA Subway Stations" } };
}

// ---------------------------------------------------------------- footprints
// Every id in this fallback chain had gone dead, so the whole function could
// only ever return "footprints dataset unresolved". Checked one at a time
// against Socrata with the exact $select below:
//   jh45-qr5r -> HTTP 400 (dataset answers, columns gone)
//   5fuc-pqz2 -> HTTP 404
//   qb5r-6dgf -> HTTP 404
// The live NYC planimetric BUILDING layer is 5zhs-2jue, and it spells the roof
// height `height_roof`, not `heightroof` — asking for the old spelling is
// itself a 400. It goes first; the previous ids are kept behind it rather than
// removed, so if a vintage is ever republished this still finds it.
//
// Nothing calls this today (server/parity-routes.js and
// server/adapters/mappluto.js each query the footprint layer directly), but a
// helper that silently cannot succeed is a trap for whoever reaches for it next.
const FOOTPRINT_CANDIDATES = [
  { id: "5zhs-2jue", height: "height_roof" },
  { id: "jh45-qr5r", height: "heightroof" },
  { id: "5fuc-pqz2", height: "heightroof" },
  { id: "qb5r-6dgf", height: "heightroof" }
];
export async function footprintsBbox(minLat, minLng, maxLat, maxLng, limit = 400) {
  for (const { id, height } of FOOTPRINT_CANDIDATES) {
    const r = await soql(id, {
      $select: `bin,base_bbl,${height},the_geom`,
      $where: `within_box(the_geom, ${maxLat}, ${minLng}, ${minLat}, ${maxLng})`,
      $limit: limit
    }, { timeoutMs: 30000 });
    if (!r.live || r.error) continue;
    // Normalise the roof height so callers see one field whichever vintage answered.
    const rows = (r.rows ?? []).map((x) => (height === "heightroof" ? x : { ...x, heightroof: x[height] }));
    return { ...r, rows, dataset: { id } };
  }
  return { live: false, rows: [], error: "footprints dataset unresolved" };
}

// ---------------------------------------------------------------- demographics (Census ACS — key required, honest otherwise)
export async function acsByZip(zip) {
  const key = process.env.CENSUS_API_KEY;
  if (!key) return { configured: false, live: false };
  const vars = {
    population: "B01003_001E", median_age: "B01002_001E", households: "B11001_001E",
    median_income: "B19013_001E", per_capita_income: "B19301_001E",
    median_gross_rent: "B25064_001E", renter: "B25003_003E", tenure_total: "B25003_001E",
    unemployed: "B23025_005E", labor_force: "B23025_003E", household_size: "B25010_001E"
  };
  const get = Object.values(vars).join(",");
  try {
    const url = `https://api.census.gov/data/2022/acs/acs5?get=${get}&for=zip%20code%20tabulation%20area:${encodeURIComponent(zip)}&key=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [header, row] = await res.json();
    const val = (code) => { const i = header.indexOf(code); const v = row?.[i]; const n = parseFloat(v); return Number.isFinite(n) && n > -6666 ? n : null; };
    const renter = val(vars.renter), tenure = val(vars.tenure_total);
    const unemp = val(vars.unemployed), lf = val(vars.labor_force);
    return {
      configured: true, live: true, geography: `ZCTA ${zip}`, vintage: "ACS 5-yr 2022",
      population: val(vars.population), median_age: val(vars.median_age),
      households: val(vars.households), household_size: val(vars.household_size),
      median_income: val(vars.median_income), per_capita_income: val(vars.per_capita_income),
      median_gross_rent: val(vars.median_gross_rent),
      renter_pct: renter != null && tenure ? Math.round((renter / tenure) * 100) : null,
      owner_pct: renter != null && tenure ? 100 - Math.round((renter / tenure) * 100) : null,
      unemployment_pct: unemp != null && lf ? Math.round((unemp / lf) * 1000) / 10 : null
    };
  } catch (e) {
    return { configured: true, live: false, error: String(e?.message ?? e) };
  }
}
