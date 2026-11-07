// Production regulatory overlay. J-51 is read from the current NYC DOF benefit
// lookup; sustainability coverage/pathways come from DOB's 2026 Covered
// Buildings List; energy/emissions facts come from the current consolidated
// LL84 disclosure. No generic LL97 emissions limit is invented because the
// applicable compliance pathway/limit is building- and use-specific.
import { Router } from "express";
import { liveBuilding } from "./live.js";
import { currentLl84ByBbl } from "./adapters/ll84-current.js";
import { dofBenefitsByBbl } from "./adapters/dof-benefits.js";
import { sustainabilityCblByBbl } from "./adapters/dob-sustainability.js";
import { safeJ51, ll97FromDisclosure } from "./cliffs-contract.js";
import { j51ByBbl } from "./adapters/j51-historical.js";
import { ll33GradeByBbl } from "./adapters/ll33-grades.js";

const router = Router();
const cleanBbl = (v) => {
  const d = String(v ?? "").replace(/[^0-9]/g, "");
  return d.length === 10 ? d : "";
};
const number = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const pickNumber = (row, ...keys) => {
  for (const key of keys) {
    const v = number(row?.[key]);
    if (v != null) return v;
  }
  return null;
};
// Superseded 2026-08-19 by the PUBLISHED LL33 grade (adapters/ll33-grades.js):
// the original reads DOB's own letterscore rather than deriving one, and the
// derivation disagreed — 78 vs the published 80 on 1008350041, and it can
// never produce the "F" that 1000160001 actually carries. Kept, unreferenced,
// pending the owner's decision on removal.
const ll33GradeFromScore = (score) => {
  if (!Number.isFinite(score)) return null;
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  return "D";
};

// The envelope the original publishes, measured 2026-08-19 across eleven BBLs:
// EXACTLY three keys — j51, ll97, ll33 — and nothing else. The rebuild was
// publishing eleven (provenance, bbl, j51Record, j51Note, ll84,
// sustainabilityCbl, sourceRecords, unknowns on top of the three), and the
// ll97 block carried two more (note, official).
//
// ll97's own key order, identical on every lot that has one:
//   ghg, gfa, type, capTons, overTons, penalty2030, status, reportYear
// The VALUES were already exact — Empire State ghg 16678, gfa 2852257,
// capTons 12921, overTons 3757, penalty2030 1007009 all match — so only the
// projection changed here.
const LL97_COVERAGE_SF = 25000;
const CLIFFS_LL97_KEYS = ["ghg", "gfa", "type", "capTons", "overTons", "penalty2030", "status", "reportYear"];
const cliffsLl97 = (v) => {
  if (!v) return null;
  const out = {};
  for (const k of CLIFFS_LL97_KEYS) out[k] = v[k] ?? null;
  return out;
};

router.get("/api/cliffs", async (req, res) => {
  const bbl = cleanBbl(req.query.bbl);
  // Measured 2026-08-19: GET /api/cliffs answers 400 {"error":"Provide a 10-digit ?bbl="}
  if (!bbl) return res.status(400).json({ error: "Provide a 10-digit ?bbl=" });
  try {
    const building = await liveBuilding(bbl).catch(() => null);

    const [benefit, cbl, ll84, j51Published, ll33Published] = await Promise.all([
      dofBenefitsByBbl(bbl),
      sustainabilityCblByBbl(bbl),
      currentLl84ByBbl(bbl),
      j51ByBbl(bbl),
      ll33GradeByBbl(bbl)
    ]);

    const benchmarkRows = ll84?.live ? (ll84.rows || []) : [];
    // WHICH LL84 row. A campus BBL carries dozens — Snug Harbor (5000760200)
    // has 111 across three years, 37 in 2024 of which only 4 report a GHG at
    // all. Taking rows[0] blindly landed on a "Not Available" sub-property and
    // published ll97:null for a building the original scores: BBL 2058363127
    // answers ghg 780 / gfa 185332 on the original.
    //
    // The rows arrive report_year DESC, so this takes the newest year present
    // and, within it, the first row that actually reports emissions.
    //
    // NOT EXACT on every campus lot, and I am saying so rather than claiming it:
    // the original's own pick is row-order dependent inside a year. On
    // 2031200020 it publishes the FIRST row carrying a GHG (2,233 t) rather
    // than the largest (19,684 t); on 2026050040 it publishes the LARGEST
    // (93,318 t) rather than the first (2,555 t); and on 4059170001 it
    // publishes null although seven 2024 rows carry a GHG. Those three cannot
    // all be true of one deterministic rule over an unordered page, so what is
    // reproducible is the year and the requirement that the row report
    // emissions. Single-record lots — the overwhelming majority — are exact.
    const latestYear = benchmarkRows.length
      ? String(benchmarkRows[0].report_year ?? benchmarkRows[0].calendar_year ?? benchmarkRows[0].year ?? "")
      : "";
    const sameYear = benchmarkRows.filter((x) =>
      String(x.report_year ?? x.calendar_year ?? x.year ?? "") === latestYear);
    const reportsGhg = (x) => {
      const v = pickNumber(x, "total_ghg_emissions_metric_tons_co2e", "total_ghg_emissions_metric",
        "total_location_based_ghg_emissions_metric_tons_co2e", "total_location_based_ghg");
      return v != null && v > 0;
    };
    const benchmark = sameYear.find(reportsGhg) || benchmarkRows.find(reportsGhg) || benchmarkRows[0] || null;
    const reportedGhg = benchmark ? pickNumber(
      benchmark,
      "total_ghg_emissions_metric_tons_co2e",
      "total_ghg_emissions_metric",
      "total_location_based_ghg_emissions_metric_tons_co2e",
      "total_location_based_ghg"
    ) : null;
    const reportYear = benchmark?.calendar_year || benchmark?.report_year || benchmark?.year || String(benchmark?.year_ending || "").slice(0, 4) || null;
    // SELF-REPORTED first, not calculated. Measured 2026-08-19: on BBL
    // 4034920025 the original publishes gfa 41912 where the LL84 row's
    // property_gfa_self_reported is 41912 and its property_gfa_calculated is
    // 43036; on 3067667504 the original publishes 93600 and the rebuild
    // published 99421 — a 5,821 gap that is exactly that row's
    // self_reported/calculated gap. capTons is gfa x intensity, so the wrong
    // column moved capTons, overTons and penalty2030 with it.
    const reportedGfa = benchmark ? pickNumber(
      benchmark,
      "property_gfa_self_reported",
      "property_gfa_calculated",
      "property_gfa_calculated_buildings",
      "dof_gross_floor_area"
    ) : null;
    const cblBuildings = cbl.live ? cbl.buildings : [];

    const uiLl97 = ll97FromDisclosure({
      reportedGhg,
      gfa: reportedGfa,
      bldgArea: building?.bldgArea,
      // PRIMARY property type, not the largest use. Measured on three lots
      // where the two columns disagree: 4157040040 primary "Mixed Use
      // Property" / largest "Office", 4001050012 primary "Mixed Use Property" /
      // largest "Refrigerated Warehouse", 2057087501 primary "Mixed Use
      // Property" / largest "Multifamily Housing" — the original publishes the
      // PRIMARY string in every one. It is not cosmetic: the 2030 intensity is
      // keyed on the published type, so 4001050012 came out capTons 56 against
      // the original's 231 (warehouse 0.00110 instead of the 0.00453 default).
      propertyType: benchmark?.primary_property_type
        || benchmark?.primary_property_type_self
        || benchmark?.largest_property_use_type
        || (cblBuildings[0]?.ll97Pathway ? `${cblBuildings[0].ll97Pathway} pathway` : null),
      reportYear
    });

    // J-51: the published y7az-s7wc record. safeJ51 remains the projection for
    // the DOF benefit-lookup path (it is what the dossier's own j51 estimate
    // labelling is built on) and is used when that page is reachable AND the
    // published dataset has no row for the lot, so a live DOF benefit is never
    // dropped on the floor.
    const j51 = j51Published.live && j51Published.j51 ? j51Published.j51 : safeJ51(benefit);

    // LL97 applies to buildings at or over 25,000 sf, and the original enforces
    // that on the LL84 SELF-REPORTED area of the row it picked: BBL 1015850014
    // reports 5,025 sf and the original answers ll97:null while the rebuild
    // published a $22,434 penalty for it. Publishing a carbon penalty for a
    // building the law does not cover is exactly the kind of plausible fake
    // figure that must never ship.
    const covered = Number.isFinite(reportedGfa) && reportedGfa >= LL97_COVERAGE_SF;
    res.json({
      j51: j51 ?? null,
      ll97: covered ? cliffsLl97(uiLl97) : null,
      ll33: ll33Published.live ? ll33Published.grade : null
    });
  } catch (e) {
    res.status(502).json({ provenance: "unavailable", error: "regulatory_sources_unavailable", message: e?.message || "Regulatory lookup failed." });
  }
});

export default router;
