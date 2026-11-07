// /api/asset-history, rebuilt from the original's own published implementation.
//
// This route is the one place https://nycremarketintel.com publishes every
// query it makes: its response carries a sources[] array with the verbatim
// Socrata URL and row count for all eight calls. Measured 2026-08-19 on
// 1008350041, 2028450001, 3011370001, 1000160001, 1012650001 and 1013157501,
// those eight are:
//
//   acris_legals    8h5j-fqxa  ?borough=1&block=835&lot=41&$select=document_id&$limit=600
//   acris_master    bnx9-e6tj  ?$where=document_id in (…)&$select=document_id, doc_type,
//                              document_amt, recorded_datetime, document_date&$limit=600
//   acris_parties   636b-3b5g  ?$where=document_id in (…)&$select=document_id, party_type,
//                              name&$limit=2000
//   pluto           64uk-42ks  ?bbl=1008350041&$limit=1
//   pluto_compset   64uk-42ks  ?$select=address, bbl, yearbuilt, yearalter1, numfloors,
//                              bldgarea, unitsres, unitstotal, bldgclass, latitude,
//                              longitude&$where=zipcode='10001' and starts_with(bldgclass,
//                              'O') and bbl != '1008350041' and latitude is not null&$limit=250
//   dob_permits     ipu4-2q9a  ?bbl=1008350041&$limit=50&$order=issuance_date DESC
//   asset_comps     usep-8jbt  ?$where=zip_code='10001' and sale_price > 250000 and
//                              gross_square_feet > 200 and sale_date > '2024-08-19T12:28:00'
//                              and building_class_at_present like 'O%' and (block != '835'
//                              or lot != '41')&$select=address, building_class_at_present,
//                              sale_price, gross_square_feet, sale_date&$order=sale_date
//                              DESC&$limit=40
//   hpd_violations  wvxf-dwi5  ?$select=count(1) as n&$where=bbl='1008350041'
//
// The class filters take the FIRST CHARACTER of the subject's PLUTO bldgclass
// ('O' for O4, 'C' for C1, 'B' for B3), block and lot are written unpadded, and
// the comps window is exactly two years before request time to the second.
import { soql } from "./adapters/socrata.js";

const PLUTO = "64uk-42ks";
const ACRIS_LEGALS = "8h5j-fqxa";
const ACRIS_MASTER = "bnx9-e6tj";
const ACRIS_PARTIES = "636b-3b5g";
const DOB_PERMITS = "ipu4-2q9a";
const ROLLING_SALES = "usep-8jbt";
const HPD_VIOLATIONS = "wvxf-dwi5";

const LEGALS_LIMIT = 600;
const MASTER_LIMIT = 600;
const PARTIES_LIMIT = 2000;
const COMPSET_LIMIT = 250;
const COMPSET_KEEP = 5;
const PERMITS_LIMIT = 50;
const COMPS_LIMIT = 40;
const COMPS_KEEP = 8;
const COMPS_MIN_PRICE = 250000;
const COMPS_MIN_SF = 200;
const COMPS_MIN_PPSF = 10;
const COMPS_WINDOW_YEARS = 2;

// Measured across five lots by comparing the original's published sales[] and
// loans[] doc types against the FULL doc-type inventory of the same documents:
//   1008350041  all: AGMT 44 SMIS 21 ASST 18 MTGE 11 AL&R 6 SAGE 6 LEAS 6 DEED 6
//                    RPTT 5 TL&R 4 SAT 4 RPTT&RET 3 MLEA 3 ASSTO 2 LDMK 2
//               sales DEED 6 | loans AGMT 44 ASST 18 MTGE 11 ASSTO 2
//   2028450001  all also carries SUBM 4, SMIS 3, SAT 1 — none of them published
//   1000160001  all also carries JUDG, REL, TERA, TERL, MISC — none published
// So sales is DEED and nothing else, and loans is exactly this four-type set.
// SAT (satisfaction) and SMIS are NOT loans, which is where the rebuild's
// count of 79 came from against the original's 75.
const SALE_DOC_TYPES = new Set(["DEED"]);
const LOAN_DOC_TYPES = new Set(["MTGE", "AGMT", "ASST", "ASSTO"]);

const SOCRATA = process.env.SOCRATA_DOMAIN || "https://data.cityofnewyork.us";
// Mirrors adapters/socrata.js soql() so a published query is the query issued.
const sourceUrl = (dataset, params) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
  return `${SOCRATA}/resource/${dataset}.json?${qs}`;
};

const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const n0 = (v) => num(v) ?? 0;
const day = (v) => (v ? String(v).slice(0, 10) : null);
const str = (v) => (v == null ? null : String(v));
const esc = (v) => String(v ?? "").replace(/'/g, "''");

// Straight-line distance in miles, the figure the original rounds to 2 dp.
const distanceMi = (aLat, aLng, bLat, bLng) => {
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export async function assetHistoryContract(bbl, now = new Date()) {
  const clean = String(bbl ?? "").replace(/[^0-9]/g, "");
  if (clean.length !== 10) return null;
  const borough = clean.slice(0, 1);
  const block = String(Number(clean.slice(1, 6)));
  const lot = String(Number(clean.slice(6)));
  const sources = [];
  const add = (id, label, endpoint, params, result, count) => {
    sources.push({ id, label, endpoint, query: sourceUrl(endpoint, params), status: result.live ? "ok" : "error", count });
    return result;
  };

  // ---- PLUTO (usage / physical) and ACRIS legals, in parallel.
  const plutoParams = { bbl: clean, $limit: 1 };
  const legalsParams = { borough, block, lot, $select: "document_id", $limit: LEGALS_LIMIT };
  const [plutoR, legalsR] = await Promise.all([
    soql(PLUTO, plutoParams),
    soql(ACRIS_LEGALS, legalsParams)
  ]);
  const plutoRow = plutoR.live ? (plutoR.rows || [])[0] || null : null;
  // Descending string sort. The original's published master/parties queries list
  // the ids in that order — for 3011370001 it is BK_8130128601203,
  // BK_8130124201601, BK_7730095801410, BK_6630021400140, 2023081600725001,
  // 2010120601045001, and for 1008350041 the FT_* ids descend before the
  // numeric ones do. Response order (what the rebuild used) produced a
  // different list for the same six documents.
  const documentIds = legalsR.live
    ? [...new Set((legalsR.rows || []).map((r) => String(r.document_id ?? "")).filter(Boolean))]
      .sort((a, z) => z.localeCompare(a))
    : [];

  // ---- ACRIS master + parties over exactly those document ids.
  const idList = documentIds.map((i) => `'${esc(i)}'`).join(",");
  const masterParams = documentIds.length
    ? { $where: `document_id in (${idList})`, $select: "document_id, doc_type, document_amt, recorded_datetime, document_date", $limit: MASTER_LIMIT }
    : null;
  const partiesParams = documentIds.length
    ? { $where: `document_id in (${idList})`, $select: "document_id, party_type, name", $limit: PARTIES_LIMIT }
    : null;
  const [masterR, partiesR] = await Promise.all([
    masterParams ? soql(ACRIS_MASTER, masterParams) : Promise.resolve({ live: true, rows: [] }),
    partiesParams ? soql(ACRIS_PARTIES, partiesParams) : Promise.resolve({ live: true, rows: [] })
  ]);

  // ---- The parcel-dependent queries, which need PLUTO's zip and class.
  const zip = str(plutoRow?.zipcode)?.trim() || "";
  const classPrefix = (str(plutoRow?.bldgclass) || "").trim().slice(0, 1);
  const compsetParams = zip && classPrefix ? {
    $select: "address, bbl, yearbuilt, yearalter1, numfloors, bldgarea, unitsres, unitstotal, bldgclass, latitude, longitude",
    $where: `zipcode='${esc(zip)}' and starts_with(bldgclass, '${esc(classPrefix)}') and bbl != '${clean}' and latitude is not null`,
    $limit: COMPSET_LIMIT
  } : null;
  const permitsParams = { bbl: clean, $limit: PERMITS_LIMIT, $order: "issuance_date DESC" };
  const since = new Date(now.getTime());
  since.setUTCFullYear(since.getUTCFullYear() - COMPS_WINDOW_YEARS);
  const compsParams = zip && classPrefix ? {
    $where: `zip_code='${esc(zip)}' and sale_price > ${COMPS_MIN_PRICE} and gross_square_feet > ${COMPS_MIN_SF} ` +
      `and sale_date > '${since.toISOString().slice(0, 19)}' and building_class_at_present like '${esc(classPrefix)}%' ` +
      `and (block != '${block}' or lot != '${lot}')`,
    $select: "address, building_class_at_present, sale_price, gross_square_feet, sale_date",
    $order: "sale_date DESC",
    $limit: COMPS_LIMIT
  } : null;
  const hpdParams = { $select: "count(1) as n", $where: `bbl='${clean}'` };

  const [compsetR, permitsR, compsR, hpdR] = await Promise.all([
    compsetParams ? soql(PLUTO, compsetParams) : Promise.resolve({ live: true, rows: [] }),
    soql(DOB_PERMITS, permitsParams),
    compsParams ? soql(ROLLING_SALES, compsParams) : Promise.resolve({ live: true, rows: [] }),
    soql(HPD_VIOLATIONS, hpdParams)
  ]);

  // ---- Projections.
  const partiesByDoc = new Map();
  for (const p of partiesR.rows || []) {
    const id = String(p.document_id ?? "");
    if (!partiesByDoc.has(id)) partiesByDoc.set(id, []);
    partiesByDoc.get(id).push(p);
  }
  // ", " between multiple party names, not "; ". Measured on 3011370001's 2023
  // deed, whose grantee the original publishes as "SANDRA FREEDMAN TRUST, DATED
  // SEPTEMBER 13, 2022, LYNN, TRUSTEE, COURTNEY L" — two ACRIS party rows
  // joined with a comma.
  const namesOfType = (id, type) => (partiesByDoc.get(id) || [])
    .filter((p) => String(p.party_type) === type)
    .map((p) => String(p.name ?? "").trim())
    .filter(Boolean)
    .join(", ");

  const masterRows = masterR.rows || [];
  // Date descending ONLY, over the master response read BACK TO FRONT.
  //
  // This settles the residual recorded here previously. The old rule was date
  // descending then DOCUMENT ID descending, which was honest about being the
  // best rule found rather than a proven one: it reproduced 1008350041,
  // 1000160001 and 3011370001 but not 2028450001's 2016-07-14 group, which the
  // original publishes as …958006, …958017, …958016, …958015, …958014, …958013,
  // …958011, …958012 — 006 ahead of everything and 011 ahead of 012. No
  // document_amt, document_date or recorded_datetime ordering explains that,
  // and neither does a stable date-only sort over the FORWARD response order.
  //
  // A stable date-only sort over the REVERSED response order explains all of
  // it. Measured 2026-08-19 by refetching each lot's own published acris_master
  // query — the verbatim URL the original prints in sources[] — and replaying
  // both candidate rules against the original's published arrays:
  //     rule                                             sales   loans
  //     response order,  stable date DESC                 5/9     3/9
  //     REVERSED response order, stable date DESC         9/9     9/9
  // over 1008350041, 1000160001, 1012650001, 2024330001, 2028450001,
  // 3002440013, 3011370001, 3059880039 and 4006500069.
  //
  // On 2028450001 the raw master response runs …486001 … …486009, …486011,
  // …486010, so read back to front that group is 010, 011, 009 … 001 — exactly
  // what the original publishes, including the 011-before-012 inversion in the
  // 958 group that no comparator on the row's own fields could produce.
  // Equivalent formulation: stable sort ASCENDING by date, then reverse.
  //
  // The response order is not a coin toss. Refetching the same published
  // acris_master URL five times returned 1 DISTINCT row order on 2028450001,
  // 1012650001 and 3059880039, so this rule is deterministic on both sides.
  const masterRowsReversed = [...masterRows].reverse();
  const byDate = (a, z) =>
    String(z.date ?? "").localeCompare(String(a.date ?? ""));

  const sales = masterRowsReversed
    .filter((d) => SALE_DOC_TYPES.has(String(d.doc_type ?? "").trim()))
    .map((d) => {
      const id = String(d.document_id ?? "");
      return {
        date: day(d.recorded_datetime || d.document_date),
        amount: n0(d.document_amt),
        docType: str(d.doc_type),
        grantor: namesOfType(id, "1") || "—",
        grantee: namesOfType(id, "2") || "—",
        docId: id
      };
    })
    .sort(byDate);

  const loans = masterRowsReversed
    .filter((d) => LOAN_DOC_TYPES.has(String(d.doc_type ?? "").trim()))
    .map((d) => {
      const id = String(d.document_id ?? "");
      return {
        date: day(d.recorded_datetime || d.document_date),
        amount: n0(d.document_amt),
        docType: str(d.doc_type),
        lender: namesOfType(id, "2") || "—",
        docId: id
      };
    })
    .sort(byDate);

  // The original does NOT resolve the permittee: applicant is the em dash on
  // every row of every probed lot, including lots whose ipu4-2q9a records carry
  // a permittee name (2028450001 -> ANTONIO FERNANDEZ, 1000160001 -> HAK MING
  // CHAN). date is the raw MM/DD/YYYY the dataset publishes, not an ISO day,
  // and type is job_type alone with no work_type suffix.
  const permits = (permitsR.rows || []).map((x) => ({
    date: str(x.issuance_date) ?? str(x.filing_date),
    type: str(x.job_type) || "—",
    status: str(x.permit_status) || "—",
    applicant: "—"
  }));

  const lat = num(plutoRow?.latitude), lng = num(plutoRow?.longitude);
  const competitiveSet = (compsetR.rows || [])
    .map((r) => {
      const rLat = num(r.latitude), rLng = num(r.longitude);
      if (rLat == null || rLng == null || lat == null || lng == null) return null;
      return {
        address: str(r.address),
        bbl: String(r.bbl ?? "").replace(/\..*$/, ""),
        distanceMi: Math.round(distanceMi(lat, lng, rLat, rLng) * 100) / 100,
        yearBuilt: n0(r.yearbuilt),
        yearAlter1: n0(r.yearalter1),
        numFloors: n0(r.numfloors),
        bldgArea: n0(r.bldgarea),
        units: n0(r.unitstotal),
        bldgClass: str(r.bldgclass),
        lat: rLat,
        lng: rLng
      };
    })
    .filter(Boolean)
    .sort((a, z) => a.distanceMi - z.distanceMi)
    .slice(0, COMPSET_KEEP);

  // A ROUNDED price-per-square-foot under $10 is dropped before the first eight
  // are taken. Solved by comparing the original's published comps against the
  // raw result of its own published query on six lots:
  //   1008350041   8.065 -> 8   DROPPED      1014937502   5.236 -> 5   DROPPED
  //   1014937502  10.913 -> 11  KEPT         3059880039   9.486 -> 9   DROPPED
  //   3002440013   9.615 -> 10  KEPT         1014937502  11.291 -> 11  KEPT
  // 9.615 and 9.486 straddle the boundary and land on opposite sides of it, so
  // the test is on the rounded figure the response publishes, not the exact
  // ratio. Rows the query returns in order are otherwise taken as they come:
  // 2028450001 and 3011370001 both publish raw rows 0..7 unchanged.
  const compsSeenAddress = new Set();
  const comps = (compsR.rows || [])
    .map((r) => {
      const price = n0(r.sale_price), sf = n0(r.gross_square_feet);
      return {
        address: str(r.address),
        date: day(r.sale_date),
        price,
        ppsf: sf > 0 ? Math.round(price / sf) : null,
        bldgClass: str(r.building_class_at_present)
      };
    })
    .filter((c) => c.ppsf != null && c.ppsf >= COMPS_MIN_PPSF)
    // ONE ROW PER ADDRESS. The rolling-sales window is a transaction log, not a
    // property list, so a building that traded twice inside the 24 months
    // appears twice — and the original publishes it once, keeping the row the
    // query returned FIRST (the most recent sale, since the query is
    // $order=sale_date DESC).
    //
    // Measured 2026-08-19 on BBL 5035380125 (41 HUSSON STREET, C2, 10305) by
    // replaying the original's own published asset_comps query and diffing the
    // eight raw rows against the seven it published. 227 BUEL AVENUE is in the
    // raw result twice — 2026-05-20 $2,950,000 / 7,956 sf / ppsf 371 and
    // 2025-12-29 $1,475,000 / 7,956 sf / ppsf 185 — and the original publishes
    // only the 2026-05-20 row. Every other field on the surviving seven rows
    // already matched. Replaying all 27 saved lots against their own published
    // queries:
    //     current rule (ppsf floor, take 8)          26/27
    //     with this de-duplication                   27/27
    //
    // Whether the de-duplication runs BEFORE or AFTER the ppsf floor is not
    // settled by any evidence, and it cannot be: the two orders differ only for
    // an address whose most recent in-window sale rounds to ppsf < 10 while an
    // older one is >= 10. Scanning the whole citywide 24-month window that
    // feeds this query — 21,668 rows over every ZIP and class — found ZERO such
    // address groups, so no request the original can answer distinguishes them.
    // It is placed after the floor because that is the reading in which a
    // junk-priced sale cannot delete a real comp.
    //
    // The key is the raw `address` string. Nothing else is observable: those
    // 21,668 rows carry no null address, none differs from its own trim() or
    // toUpperCase(), and no ZIP+class group holds two spellings of one
    // normalised address. 275 groups DO repeat an exact address, so this fires
    // often, not only on the lot that exposed it.
    .filter((c) => {
      const key = String(c.address ?? "");
      if (compsSeenAddress.has(key)) return false;
      compsSeenAddress.add(key);
      return true;
    })
    .slice(0, COMPS_KEEP);

  const bldgArea = n0(plutoRow?.bldgarea);
  const lastSale = sales.find((s) => s.amount > 0) || null;
  const metrics = {
    lastSalePrice: lastSale?.amount || null,
    lastSaleDate: lastSale?.date || null,
    lastSalePpsf: lastSale?.amount && bldgArea > 0 ? Math.round(lastSale.amount / bldgArea) : null,
    holdYears: lastSale?.date
      ? Math.max(0, Math.round(((now.getTime() - new Date(lastSale.date).getTime()) / (365.25 * 864e5)) * 10) / 10)
      : null
  };

  const assessTotal = n0(plutoRow?.assesstot);
  const assessLand = n0(plutoRow?.assessland);

  add("acris_legals", "ACRIS legals (lot documents)", ACRIS_LEGALS, legalsParams, legalsR, documentIds.length);
  if (masterParams) add("acris_master", "ACRIS master (doc type / amount / date)", ACRIS_MASTER, masterParams, masterR, masterRows.length);
  if (partiesParams) add("acris_parties", "ACRIS parties (grantor / grantee)", ACRIS_PARTIES, partiesParams, partiesR, (partiesR.rows || []).length);
  add("pluto", "PLUTO (usage / physical)", PLUTO, plutoParams, plutoR, plutoRow ? 1 : 0);
  if (compsetParams) add("pluto_compset", "PLUTO competitive set (nearest same-class)", PLUTO, compsetParams, compsetR, competitiveSet.length);
  add("dob_permits", "DOB permit history", DOB_PERMITS, permitsParams, permitsR, permits.length);
  if (compsParams) add("asset_comps", "Comparable sales (same ZIP + class, 24-mo)", ROLLING_SALES, compsParams, compsR, comps.length);
  const hpdCount = hpdR.live ? n0((hpdR.rows || [])[0]?.n) : null;
  add("hpd_violations", "HPD violations (by BBL)", HPD_VIOLATIONS, hpdParams, hpdR, hpdCount ?? 0);

  // The envelope, in the original's own key order. `address` is OMITTED, not
  // emptied, when PLUTO has no row for the lot: measured on 1012650001, where
  // the original's keys are bbl, pluto, assessment, … with no address at all.
  return {
    bbl: clean,
    ...(plutoRow ? { address: str(plutoRow.address) || "—" } : {}),
    pluto: plutoRow ? {
      yearBuilt: n0(plutoRow.yearbuilt),
      yearAlter1: n0(plutoRow.yearalter1),
      yearAlter2: n0(plutoRow.yearalter2),
      landUse: str(plutoRow.landuse),
      bldgClass: str(plutoRow.bldgclass),
      unitsRes: n0(plutoRow.unitsres),
      unitsTotal: n0(plutoRow.unitstotal),
      lotArea: n0(plutoRow.lotarea),
      bldgArea: bldgArea,
      builtFar: n0(plutoRow.builtfar),
      maxFar: Math.max(n0(plutoRow.residfar), n0(plutoRow.commfar), n0(plutoRow.facilfar)),
      owner: str(plutoRow.ownername),
      zoning: str(plutoRow.zonedist1),
      numFloors: n0(plutoRow.numfloors),
      zip: str(plutoRow.zipcode),
      lat,
      lng
    } : null,
    assessment: plutoRow ? {
      assessTotal,
      assessLand,
      assessImprovements: Math.max(0, assessTotal - assessLand),
      exemptTotal: n0(plutoRow.exempttot)
    } : null,
    competitiveSet,
    sales,
    loans,
    permits,
    metrics,
    comps,
    signals: { dobViolations: null, hpdViolations: hpdCount },
    sources
  };
}
