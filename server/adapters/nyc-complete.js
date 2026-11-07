// Complete, fail-closed NYC public-record adapters used by ingestion.
//
// Product/UI adapters intentionally preserve observed bounded response depths.
// These helpers are different: a warehouse run that may later earn an
// authoritative freshness certificate must exhaust the source result set. Every
// query therefore uses soqlAll(), whose safety ceiling FAILS rather than
// returning a truncated result.
import { soqlAll, escSoql } from "./socrata.js";
import { DS, parseBbl } from "./nyc.js";

const ACRIS_MASTER_FIELDS = "document_id,doc_type,document_date,document_amt,recorded_datetime,crfn";
const ACRIS_PARTY_FIELDS = "document_id,party_type,name,address_1,address_2,city,state,zip";
const DOB_NOW_FIELDS = "job_filing_number,filing_date,job_type,filing_status,house_no,street_name,borough,block,lot,bin,applicant_first_name,applicant_last_name,owner_s_business_name";
const DOB_PERMIT_FIELDS = [
  "issuance_date", "job_type", "permit_status", "work_type", "permit_type",
  "permit_sequence__", "permittee_s_business_name", "permittee_s_first_name",
  "permittee_s_last_name", "permittee_s_phone__", "filing_date", "job__",
  "job_doc___", "bin__"
].join(",");
const HPD_VIOLATION_FIELDS = "violationid,inspectiondate,currentstatus,violationstatus,class,novdescription";
const ECB_FIELDS = "ecb_violation_number,ecb_violation_status,issue_date,severity,violation_type,penality_imposed,amount_paid,balance_due";
const TAX_FIELDS = "year,period,pymkttot,pymktland,pyacttot,pyactland,pyactextot,pytxbtot,pytaxclass,curmkttot,curacttot,curactextot,curtxbtot,curtaxclass";

const all = (dataset, params, maxRows = 100000) => soqlAll(dataset, params, {
  pageSize: 1000,
  maxRows,
  timeoutMs: 40000,
  ttlMs: 30 * 60 * 1000,
  retries: 2
});

export async function completeAcrisByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, documents: [], error: "invalid_bbl" };

  const legals = await all(DS.acrisLegals, {
    $select: "document_id",
    $where: `borough='${p.boro}' AND block='${p.block}' AND lot='${p.lot}'`,
    $order: "document_id ASC"
  }, 50000);
  if (!legals.live) return { live: false, documents: [], error: legals.error || "acris_legals_unavailable" };

  const ids = [...new Set((legals.rows || []).map((r) => String(r.document_id || "")).filter(Boolean))];
  if (!ids.length) return { live: true, documents: [], legalsCount: 0, documentCount: 0 };

  const documents = [];
  const parties = {};
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const list = chunk.map((id) => `'${escSoql(id)}'`).join(",");
    const [master, party] = await Promise.all([
      all(DS.acrisMaster, {
        $select: ACRIS_MASTER_FIELDS,
        $where: `document_id in(${list})`,
        $order: "document_id ASC"
      }, 10000),
      all(DS.acrisParties, {
        $select: ACRIS_PARTY_FIELDS,
        $where: `document_id in(${list})`,
        $order: "document_id ASC,party_type ASC,name ASC"
      }, 20000)
    ]);
    if (!master.live) return { live: false, documents: [], error: master.error || "acris_master_unavailable" };
    if (!party.live) return { live: false, documents: [], error: party.error || "acris_parties_unavailable" };
    documents.push(...(master.rows || []));
    for (const row of party.rows || []) {
      const id = String(row.document_id || "");
      if (!id) continue;
      (parties[id] ||= []).push(row);
    }
  }

  const byId = new Map();
  for (const row of documents) {
    const id = String(row.document_id || "");
    if (!id) continue;
    byId.set(id, { ...row, parties: parties[id] || [] });
  }

  // The ACRIS Legals index is the authoritative statement that these document
  // IDs touch this lot. If Master fails to return any referenced ID, silently
  // dropping it would make a certifying warehouse incomplete while still
  // claiming success. Treat that cross-dataset mismatch as unavailable instead.
  const missingMasterIds = ids.filter((id) => !byId.has(id));
  if (missingMasterIds.length) {
    return {
      live: false,
      documents: [],
      error: `acris_master_missing_${missingMasterIds.length}_referenced_documents`,
      missingMasterIds: missingMasterIds.slice(0, 20)
    };
  }

  return {
    live: true,
    documents: [...byId.values()],
    legalsCount: legals.rows.length,
    documentCount: byId.size
  };
}

export async function completeDobPermitsByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [], error: "invalid_bbl" };
  return all(DS.dobPermits, {
    $select: DOB_PERMIT_FIELDS,
    $where: `borough='${escSoql(p.boroName)}' AND block='${p.block5}' AND lot='${p.lot5}'`,
    $order: "issuance_date DESC,job__ ASC,permit_sequence__ ASC"
  }, 50000);
}

export async function completeDobNowByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [], error: "invalid_bbl" };
  return all(DS.dobNow, {
    $select: DOB_NOW_FIELDS,
    $where: `upper(borough)='${escSoql(p.boroName)}' AND block='${p.block}' AND lot='${p.lot}'`,
    $order: "filing_date DESC,job_filing_number ASC"
  }, 50000);
}

export async function completeHpdViolationsByBbl(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [], error: "invalid_bbl" };
  return all(DS.hpdViolations, {
    $select: HPD_VIOLATION_FIELDS,
    $where: `bbl='${p.digits}'`,
    $order: "inspectiondate DESC,violationid ASC"
  }, 100000);
}

export async function completeEcbByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [], error: "invalid_bbl" };
  return all(DS.ecb, {
    $select: ECB_FIELDS,
    $where: `boro='${p.boro}' AND block='${p.block5}' AND lot='${p.lot4}'`,
    $order: "issue_date DESC,ecb_violation_number ASC"
  }, 100000);
}

export async function completeTaxHistoryByBbl(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, rows: [], error: "invalid_bbl" };
  return all(DS.pvad, {
    $select: TAX_FIELDS,
    $where: `parid='${p.digits}'`,
    $order: "year DESC,period ASC"
  }, 10000);
}
