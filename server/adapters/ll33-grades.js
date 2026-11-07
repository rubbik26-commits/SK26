// NYC DOB's PUBLISHED Local Law 33 energy-efficiency grade, read as a record
// rather than derived from a benchmarking score.
//
// Measured 2026-08-19: https://nycremarketintel.com serves ll33 straight out of
// dataset 355w-xvp2, "DOB Sustainability Compliance Map: Local Law 33" —
// {grade: <letterscore>, score: <energy_star_score>}, and null for a lot that
// has no row. Eight probed BBLs, eight matches:
//   1008350041 B/80   1008350001 C/66   1000160001 F/0    2028450001 C/64
//   1000477501 B/80   3009810111 null   1012650001 null   3011370001 null
// The rebuild was instead DERIVING the grade from the LL84 ENERGY STAR score
// with statutory bands, which gave 78 where the published record says 80, and
// would never produce the "F" that 1000160001 actually carries.
import { soql } from "./socrata.js";

export const LL33_DATASET = "355w-xvp2";

export async function ll33GradeByBbl(bbl) {
  const clean = String(bbl ?? "").replace(/[^0-9]/g, "");
  if (clean.length !== 10) return { live: false, grade: null, error: "invalid_bbl" };
  const r = await soql(LL33_DATASET, { $where: `bbl='${clean}'`, $limit: 1 });
  if (!r.live) return { live: false, grade: null, error: r.error || "ll33_dataset_unavailable" };
  const row = (r.rows || [])[0];
  if (!row) return { live: true, grade: null, row: null, error: null };
  const letter = String(row.letterscore ?? "").trim();
  const score = Number(String(row.energy_star_score ?? "").replace(/[^0-9.-]/g, ""));
  if (!letter) return { live: true, grade: null, row, error: null };
  return {
    live: true,
    // Exactly the two keys the original publishes, in its order.
    grade: { grade: letter, score: Number.isFinite(score) ? score : null },
    row,
    error: null
  };
}
