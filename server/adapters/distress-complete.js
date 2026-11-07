import { soqlAll, escSoql } from "./socrata.js";
import { DS, parseBbl } from "./nyc.js";
import { completeHpdViolationsByBbl } from "./nyc-complete.js";

const SAFETY = "855j-jady";
const LEGACY = "3h2n-5cm9";
const active = (v) => !/closed|dismissed|resolved|cured|inactive|disposed/i.test(String(v ?? ""));
const ecbActive = (v) => !/resolv/i.test(String(v ?? ""));
const money = (v) => { const n = Number(String(v ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
const BORO = {
  1: { name: "MANHATTAN", abbr: "MN" },
  2: { name: "BRONX", abbr: "BX" },
  3: { name: "BROOKLYN", abbr: "BK" },
  4: { name: "QUEENS", abbr: "QN" },
  5: { name: "STATEN ISLAND", abbr: "SI" }
};

const all = (dataset, params, maxRows = 100000) => soqlAll(dataset, params, {
  pageSize: 5000,
  maxRows,
  timeoutMs: 40000,
  ttlMs: 30 * 60 * 1000,
  retries: 2
});

export async function completeDobViolationsByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, complete: false, safety: [], legacy: [], ecb: [], error: "invalid_bbl" };
  const eitherForm = (col, bare, padded) => bare === padded
    ? `${col}='${bare}'`
    : `(${col}='${bare}' OR ${col}='${padded}')`;
  const lotWhere = `${eitherForm("block", p.block, p.block5)} AND ${eitherForm("lot", p.lot, p.lot4)}`;
  const boroWhere = `boro='${p.boro}' AND ${lotWhere}`;
  const b = BORO[p.boro];
  const safetyWhere = `(${[`borough='${p.boro}'`, `upper(borough)='${b.name}'`, `upper(borough)='${b.abbr}'`].join(" OR ")}) AND ${lotWhere}`;

  const [safety, legacy, ecb] = await Promise.all([
    all(SAFETY, {
      $select: "bin,violation_issue_date,violation_number,violation_type,violation_remarks,violation_status,device_number,device_type,cycle_end_date,borough,block,lot,house_number,street,city,state,zip",
      $where: safetyWhere,
      $order: "violation_issue_date DESC,violation_number ASC"
    }),
    all(LEGACY, {
      $select: "isn_dob_bis_viol,boro,bin,block,lot,issue_date,violation_type_code,violation_number,house_number,street,disposition_date,disposition_comments,device_number,description,ecb_number,violation_category,violation_type",
      $where: boroWhere,
      $order: "issue_date DESC,isn_dob_bis_viol ASC"
    }),
    all(DS.ecb, {
      $select: "ecb_violation_number,ecb_violation_status,dob_violation_number,bin,boro,block,lot,hearing_date,served_date,issue_date,severity,violation_type,respondent_name,penality_imposed,amount_paid,balance_due,hearing_status,certification_status",
      $where: boroWhere,
      $order: "issue_date DESC,ecb_violation_number ASC"
    })
  ]);
  if (!safety.live || !legacy.live || !ecb.live || safety.complete !== true || legacy.complete !== true || ecb.complete !== true) {
    return {
      live: false,
      complete: false,
      safety: [], legacy: [], ecb: [],
      error: "dob_violation_sources_incomplete",
      sourceStatus: {
        safety: safety.live && safety.complete === true ? "live" : "unavailable",
        legacy: legacy.live && legacy.complete === true ? "live" : "unavailable",
        ecb: ecb.live && ecb.complete === true ? "live" : "unavailable"
      }
    };
  }

  const safetyRows = (safety.rows || []).map((r) => ({
    source: "DOB Safety Violations", dataset: SAFETY, number: r.violation_number || null,
    issued: String(r.violation_issue_date || "").slice(0, 10) || null, type: r.violation_type || null,
    description: r.violation_remarks || null, status: r.violation_status || null, active: active(r.violation_status),
    bin: r.bin || null, deviceNumber: r.device_number || null, deviceType: r.device_type || null
  }));
  const legacyRows = (legacy.rows || []).map((r) => ({
    source: "DOB Violations (BIS)", dataset: LEGACY, number: r.violation_number || r.isn_dob_bis_viol || null,
    issued: String(r.issue_date || "").replace(/^(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3") || null,
    type: r.violation_type || r.violation_type_code || null, description: r.description || r.disposition_comments || null,
    status: r.violation_category || null, active: !r.disposition_date && active(r.violation_category), bin: r.bin || null,
    ecbNumber: r.ecb_number || null, dispositionDate: r.disposition_date || null
  }));
  const ecbRows = (ecb.rows || []).map((r) => ({
    source: "DOB ECB/OATH Violations", dataset: DS.ecb, number: r.ecb_violation_number || r.dob_violation_number || null,
    issued: String(r.issue_date || "").slice(0, 10) || null, type: r.violation_type || null, severity: r.severity || null,
    status: r.ecb_violation_status || r.hearing_status || null, active: ecbActive(r.ecb_violation_status), bin: r.bin || null,
    respondent: r.respondent_name || null, penaltyImposed: money(r.penality_imposed), amountPaid: money(r.amount_paid),
    balanceDue: money(r.balance_due), certificationStatus: r.certification_status || null
  }));

  return {
    live: true, complete: true, bbl: p.digits,
    safety: safetyRows, legacy: legacyRows, ecb: ecbRows,
    sourceStatus: { safety: "live", legacy: "live", ecb: "live" }
  };
}

export async function complete311ByBbl(bbl, monthsBack = 12) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, complete: false, rows: [], error: "invalid_bbl" };
  const since = new Date(Date.now() - monthsBack * 30.4 * 864e5).toISOString().slice(0, 10);
  const r = await all(DS.s311, {
    $select: "created_date,complaint_type,descriptor,status,incident_address",
    $where: `bbl='${escSoql(p.digits)}' AND created_date > '${since}'`,
    $order: "created_date DESC,unique_key ASC"
  }, 200000);
  return r.live && r.complete === true
    ? { live: true, complete: true, rows: r.rows || [] }
    : { live: false, complete: false, rows: [], error: r.error || "311_incomplete" };
}

export async function completeDistressEvidence(bbl) {
  const [hpd, dob, complaints] = await Promise.all([
    completeHpdViolationsByBbl(bbl).catch((e) => ({ live: false, rows: [], error: e?.message })),
    completeDobViolationsByLot(bbl).catch((e) => ({ live: false, complete: false, safety: [], legacy: [], ecb: [], error: e?.message })),
    complete311ByBbl(bbl, 12).catch((e) => ({ live: false, complete: false, rows: [], error: e?.message }))
  ]);
  const hpdComplete = hpd?.live === true;
  if (!hpdComplete || dob?.live !== true || dob?.complete !== true || complaints?.live !== true || complaints?.complete !== true) {
    return {
      live: false,
      error: "distress_sources_incomplete",
      sourceStatus: {
        hpd: hpdComplete ? "live" : "unavailable",
        dobSafety: dob?.sourceStatus?.safety || "unavailable",
        dobLegacy: dob?.sourceStatus?.legacy || "unavailable",
        ecb: dob?.sourceStatus?.ecb || "unavailable",
        threeOneOne: complaints?.live ? "live" : "unavailable"
      }
    };
  }
  return { live: true, hpd, dob, complaints };
}
