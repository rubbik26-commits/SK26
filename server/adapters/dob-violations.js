// Complete DOB violation layer. NYC publishes newer DOB NOW Safety civil
// penalties separately from legacy BIS DOB Violations; OATH/ECB summonses are a
// third dataset. Query all three by borough + tax lot so a block/lot reused in
// another borough can never contaminate this parcel's distress record.
import { soql } from "./socrata.js";
import { parseBbl, DS } from "./nyc.js";

export const DOB_VIOLATION_DS = {
  safety: "855j-jady", // DOB Safety Violations (newer DOB NOW civil penalties)
  legacy: "3h2n-5cm9", // DOB Violations (older BIS civil penalties)
  ecb: DS.ecb
};

const active = (v) => !/closed|dismissed|resolved|cured|inactive|disposed/i.test(String(v ?? ""));

// ECB has its own three-value vocabulary and the shared predicate misreads it.
//
// `ecb_violation_status` is exactly ACTIVE, RESOLVE or Unknown — verified by
// grouping the live dataset. The shared rule above tests for "resolved" WITH a
// trailing d, which never matches "RESOLVE", so every resolved summons counted
// as open: BBL 1008350041 has 94 ECB rows of which 0 are unresolved, and this
// reported all 94 as active. Combined with the block/lot padding bug below that
// hid the rows entirely, the same field was capable of reading 0 or 94 for the
// same building depending on which defect won.
//
// "Unknown" is treated as unresolved on purpose: an unreadable status is not
// evidence that a summons was satisfied, and the conservative direction for a
// distress signal is to surface it rather than clear it.
const ecbActive = (v) => !/resolv/i.test(String(v ?? ""));
const money = (v) => { const n=Number(String(v??"").replace(/[$,]/g,"")); return Number.isFinite(n)?n:null; };
const BORO = {
  1: { name: "MANHATTAN", abbr: "MN" },
  2: { name: "BRONX", abbr: "BX" },
  3: { name: "BROOKLYN", abbr: "BK" },
  4: { name: "QUEENS", abbr: "QN" },
  5: { name: "STATEN ISLAND", abbr: "SI" }
};

export async function dobViolationsByLot(bbl) {
  const p=parseBbl(bbl);
  if(!p)return {live:false,error:"invalid bbl",safety:[],legacy:[],ecb:[]};
  // Block and lot must match BOTH the padded and unpadded spellings.
  //
  // These datasets do not agree with each other on the format. ECB
  // (6bgk-3dad) and the legacy BIS violations (3h2n-5cm9) store block and lot
  // ZERO-PADDED as text — '00372' / '0009' — while this built the filter from
  // the unpadded values, so the query matched nothing at all. Every ECB
  // summons on every parcel was invisible: verified against the live dataset,
  // BBL 1003720009 returns 0 rows unpadded and 2 padded, 3009020001 returns 0
  // and 3, and BBL 1008350041 returns 0 and 2 on the legacy set. The dossier
  // therefore published ecbViolations: 0 for buildings that have open
  // summonses, and the distress score treated them as clean.
  //
  // DOB Safety (855j-jady) stores these as numbers and matches either spelling,
  // so accepting both forms is correct everywhere and lossless: a row can only
  // be in one format, and both are asked for.
  const eitherForm = (col, bare, padded) =>
    bare === padded ? `${col}='${bare}'` : `(${col}='${bare}' OR ${col}='${padded}')`;
  const lotWhere=`${eitherForm("block", p.block, p.block5)} AND ${eitherForm("lot", p.lot, p.lot4)}`;
  const boroWhere=`boro='${p.boro}' AND ${lotWhere}`;
  const b = BORO[p.boro];
  // Safety uses a `borough` text field rather than legacy `boro`. Accept the
  // official numeric code plus the normal NYC name/abbreviation representations,
  // but never block+lot alone.
  const safetyWhere=`(${[`borough='${p.boro}'`,`upper(borough)='${b.name}'`,`upper(borough)='${b.abbr}'`].join(" OR ")}) AND ${lotWhere}`;
  const [safety,legacy,ecb]=await Promise.all([
    soql(DOB_VIOLATION_DS.safety,{
      $select:"bin,violation_issue_date,violation_number,violation_type,violation_remarks,violation_status,device_number,device_type,cycle_end_date,borough,block,lot,house_number,street,city,state,zip",
      $where:safetyWhere,$order:"violation_issue_date DESC",$limit:500
    },{ttlMs:30*60*1000}),
    soql(DOB_VIOLATION_DS.legacy,{
      $select:"isn_dob_bis_viol,boro,bin,block,lot,issue_date,violation_type_code,violation_number,house_number,street,disposition_date,disposition_comments,device_number,description,ecb_number,violation_category,violation_type",
      $where:boroWhere,$order:"issue_date DESC",$limit:500
    },{ttlMs:30*60*1000}),
    soql(DOB_VIOLATION_DS.ecb,{
      $select:"ecb_violation_number,ecb_violation_status,dob_violation_number,bin,boro,block,lot,hearing_date,served_date,issue_date,severity,violation_type,respondent_name,penality_imposed,amount_paid,balance_due,hearing_status,certification_status",
      $where:boroWhere,$order:"issue_date DESC",$limit:500
    },{ttlMs:30*60*1000})
  ]);
  if(!safety.live && !legacy.live && !ecb.live)return {live:false,error:"DOB violation sources unavailable",safety:[],legacy:[],ecb:[]};

  const safetyRows=(safety.rows||[]).map((r)=>({
    source:"DOB Safety Violations",dataset:DOB_VIOLATION_DS.safety,number:r.violation_number||null,
    issued:String(r.violation_issue_date||"").slice(0,10)||null,type:r.violation_type||null,
    description:r.violation_remarks||null,status:r.violation_status||null,active:active(r.violation_status),
    bin:r.bin||null,deviceNumber:r.device_number||null,deviceType:r.device_type||null
  }));
  const legacyRows=(legacy.rows||[]).map((r)=>({
    source:"DOB Violations (BIS)",dataset:DOB_VIOLATION_DS.legacy,number:r.violation_number||r.isn_dob_bis_viol||null,
    issued:String(r.issue_date||"").replace(/^(\d{4})(\d{2})(\d{2}).*/,"$1-$2-$3")||null,
    type:r.violation_type||r.violation_type_code||null,description:r.description||r.disposition_comments||null,
    status:r.violation_category||null,active:!r.disposition_date && active(r.violation_category),bin:r.bin||null,
    ecbNumber:r.ecb_number||null,dispositionDate:r.disposition_date||null
  }));
  const ecbRows=(ecb.rows||[]).map((r)=>({
    source:"DOB ECB/OATH Violations",dataset:DOB_VIOLATION_DS.ecb,number:r.ecb_violation_number||r.dob_violation_number||null,
    issued:String(r.issue_date||"").slice(0,10)||null,type:r.violation_type||null,severity:r.severity||null,
    status:r.ecb_violation_status||r.hearing_status||null,active:ecbActive(r.ecb_violation_status),bin:r.bin||null,
    respondent:r.respondent_name||null,penaltyImposed:money(r.penality_imposed),amountPaid:money(r.amount_paid),
    balanceDue:money(r.balance_due),certificationStatus:r.certification_status||null
  }));
  return {
    live:true,provenance:"live",bbl:p.digits,safety:safetyRows,legacy:legacyRows,ecb:ecbRows,
    sourceStatus:{safety:safety.live?"live":"unavailable",legacy:legacy.live?"live":"unavailable",ecb:ecb.live?"live":"unavailable"},
    retrievedAt:new Date().toISOString()
  };
}
