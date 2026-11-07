import { soqlAll, escSoql } from "./socrata.js";
import { DS, DOBNOW_PIPELINE_WHERE } from "./nyc.js";

const FIELDS = [
  "job_filing_number", "filing_date", "job_type", "filing_status",
  "house_no", "street_name", "borough", "block", "lot", "bin", "bbl", "postcode",
  "proposed_dwelling_units", "total_construction_floor_area",
  "applicant_business_name", "applicant_first_name", "applicant_last_name",
  "owner_first_name", "owner_last_name", "owner_s_business_name",
  "foundation_work_type_", "full_demolition_work_type_"
].join(",");

export async function completeDobNowPipelineByZips(zips, monthsBack = 36) {
  const clean = [...new Set((zips || []).map((z) => String(z).trim()).filter((z) => /^\d{5}$/.test(z)))];
  if (!clean.length) return { live: false, complete: false, rows: [], error: "zips_required" };
  const since = new Date(Date.now() - monthsBack * 30.4 * 864e5).toISOString().slice(0, 10);
  const list = clean.map((z) => `'${escSoql(z)}'`).join(",");

  const r = await soqlAll(DS.dobNow, {
    $select: FIELDS,
    $where: `postcode in(${list}) AND filing_date > '${since}' AND ${DOBNOW_PIPELINE_WHERE}`,
    $order: "filing_date DESC,job_filing_number ASC"
  }, {
    pageSize: 5000,
    maxRows: 200000,
    timeoutMs: 40000,
    ttlMs: 30 * 60 * 1000,
    retries: 2
  });
  if (!r.live || r.complete !== true) {
    return { live: false, complete: false, rows: [], error: r.error || "dob_now_pipeline_incomplete" };
  }

  return { live: true, complete: true, rows: r.rows || [], since };
}
