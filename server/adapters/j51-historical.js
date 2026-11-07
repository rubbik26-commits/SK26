// NYC DOF's published J-51 exemption/abatement record.
//
// Measured 2026-08-19: https://nycremarketintel.com serves the dossier's j51
// block out of Socrata dataset y7az-s7wc, "J-51 Exemption and Abatement
// (Historical)", NOT out of the DOF benefit-lookup web page. The page is a
// stateful ASP.NET datalet that is currently answering "The System is
// currently unavailable due to maintenance" (and 403 under any user-agent), so
// the rebuild's scraper returns nothing while the original still publishes
// J-51 — which is what exposed the wrong source.
//
// The dataset's columns are b / block / lot / tax_year / init_year / ex_years,
// and the original's four published fields map onto them directly:
//   initYear = init_year, exYears = ex_years, endYear = init_year + ex_years
//
// ROW SELECTION, solved across 21 lots: among the rows at the LATEST tax_year,
// take the LOWEST init_year (the sentinel 9999 rows are excluded), and among
// ties the LOWEST ex_years. Two rival rules were falsified:
//   highest init_year  — 2048500051 has init 2012 and 2016 at tax_year 2018,
//                        and the original publishes 2012.
//   longest ex_years   — 1003980018 has 2000/14 and 2004/34 at tax_year 2018,
//                        1007470001 has 2008/14 and 2013/34, 1007490024 has
//                        2007/14 and 2013/34, 1007520001 has 2008/14 and
//                        2011/34, 1007710046 has 2007/14 and 2007/34; the
//                        original publishes the 14-year row in every one.
//
// STATUS BANDS, solved against the same route in calendar year 2026:
//   endYear 2020 expired | 2025 expired | 2026 expiring | 2027 expiring
//   endYear 2028 expiring | 2029 expiring | 2030 active | 2032 active | 2034 active
// i.e. expired below the current year, expiring through current year + 3,
// active beyond it.
import { soql } from "./socrata.js";

export const J51_DATASET = "y7az-s7wc";
const INIT_YEAR_SENTINEL = 9999;
export const J51_EXPIRING_HORIZON_YEARS = 3;

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function j51Status(endYear, now) {
  if (endYear < now) return "expired";
  if (endYear <= now + J51_EXPIRING_HORIZON_YEARS) return "expiring";
  return "active";
}

export async function j51ByBbl(bbl, now = new Date().getUTCFullYear()) {
  const clean = String(bbl ?? "").replace(/[^0-9]/g, "");
  if (clean.length !== 10) return { live: false, j51: null, error: "invalid_bbl" };
  const borough = clean.slice(0, 1);
  const block = String(Number(clean.slice(1, 6)));
  const lot = String(Number(clean.slice(6)));

  const r = await soql(J51_DATASET, {
    $select: "b,block,lot,tax_year,init_year,ex_years",
    $where: `b='${borough}' AND block='${block}' AND lot='${lot}'`,
    $limit: 200
  });
  if (!r.live) return { live: false, j51: null, error: r.error || "j51_dataset_unavailable" };

  const rows = (r.rows || [])
    .map((x) => ({ taxYear: num(x.tax_year), init: num(x.init_year), ex: num(x.ex_years) }))
    .filter((x) => x.taxYear != null && x.init != null && x.ex != null && x.init !== INIT_YEAR_SENTINEL && x.init > 1000 && x.init < 2100);
  if (!rows.length) return { live: true, j51: null, rows: 0, error: null };

  const latest = Math.max(...rows.map((x) => x.taxYear));
  const chosen = rows
    .filter((x) => x.taxYear === latest)
    .sort((a, z) => a.init - z.init || a.ex - z.ex)[0];
  const endYear = chosen.init + chosen.ex;

  return {
    live: true,
    rows: rows.length,
    // Exactly the four keys the original publishes, in its order.
    j51: { initYear: chosen.init, exYears: chosen.ex, endYear, status: j51Status(endYear, now) },
    error: null
  };
}
