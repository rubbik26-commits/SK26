// Public DOB development pipeline. This pathname is also used by the private
// CRM, so this router owns only requests that actually carry ?zips=.
//
// Rebuilt 2026-08-19 from the original's own published sources[] entry, which
// carries the verbatim query it issues:
//   https://data.cityofnewyork.us/resource/w9ak-ipjd.json
//     ?$where=postcode in ('11216') and filing_date > '2023-08-19T12:27:53'
//            and (job_type='New Building' or full_demolition_work_type_='YES'
//                 or foundation_work_type_='YES')
//     &$select=job_filing_number, house_no, street_name, bbl, bin, job_type,
//              filing_status, filing_date, proposed_dwelling_units,
//              total_construction_floor_area, applicant_business_name,
//              owner_first_name, owner_last_name, full_demolition_work_type_,
//              foundation_work_type_
//     &$order=filing_date DESC&$limit=600
// ONE call capped at 600 rows — not an exhaustive traversal. ZIP 10314 returns
// exactly 600 on the original and its counts sum to 600, so the cap is real and
// the rebuild's paging was reading past it.
//
// Rolling Sales is unrelated to this feature and is deliberately not imported:
// a DOF outage must not take down a DOB construction pipeline.
import { Router } from "express";
import { soql } from "./adapters/socrata.js";

const router = Router();
const DOB_NOW = "w9ak-ipjd";
const WINDOW_MONTHS = 36;
const SITE_LIMIT = 60;
const ROW_LIMIT = 600;
const PIPELINE_SELECT = "job_filing_number, house_no, street_name, bbl, bin, job_type, " +
  "filing_status, filing_date, proposed_dwelling_units, total_construction_floor_area, " +
  "applicant_business_name, owner_first_name, owner_last_name, full_demolition_work_type_, " +
  "foundation_work_type_";
const SOCRATA = process.env.SOCRATA_DOMAIN || "https://data.cityofnewyork.us";
// Mirrors adapters/socrata.js soql() so the published query is the one issued.
const sourceUrl = (dataset, params) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
  return `${SOCRATA}/resource/${dataset}.json?${qs}`;
};
const zipsFrom = (v) => [...new Set(String(v ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d{5}$/.test(x)))];
const n = (v) => Number(v || 0).toLocaleString("en-US");
const yes = (v) => String(v ?? "").toUpperCase() === "YES";

function bblOf(x) {
  if (x.bbl) {
    const d = String(x.bbl).replace(/\..*$/, "").replace(/[^0-9]/g, "");
    if (/^[1-5]\d{9}$/.test(d)) return d;
  }
  const borough = String(x.borough ?? "").trim();
  const digit = ({ MANHATTAN: "1", BRONX: "2", BROOKLYN: "3", QUEENS: "4", "STATEN ISLAND": "5" })[borough.toUpperCase()]
    || (/^[1-5]$/.test(borough) ? borough : "");
  const block = String(x.block ?? "").replace(/[^0-9]/g, "");
  const lot = String(x.lot ?? "").replace(/[^0-9]/g, "");
  // Empty string, not null, when the filing carries no resolvable BBL — that is
  // what the original publishes (measured on 32 ST ANDREWS PLACE bin 3430255,
  // 650 REAR ST MARK'S AVENUE bin 3324493, 205 HAWTHORNE AVENUE bin 5030360).
  return digit && block && lot ? `${digit}${block.padStart(5, "0")}${lot.padStart(4, "0")}` : "";
}

// EXACT equality on job_type, not a substring test. ZIP 11216 carries 30 rows
// of "ALT-CO - New Building with Existing Elements to Remain" which
// /new building/i matched: the rebuild counted 267 new buildings where the
// original counts 237, and 60 foundations where it counts 90. With exact
// equality the three counts come to 237 / 90 / 39, which is what the original
// publishes and which sums to the 366 rows the query returns.
function kindOf(x) {
  if (x.job_type === "New Building") return "New Building";
  if (yes(x.full_demolition_work_type_)) return "Demolition";
  if (yes(x.foundation_work_type_)) return "Foundation";
  return x.job_type ?? "—";
}

function siteOf(x) {
  return {
    address: [x.house_no, x.street_name].filter(Boolean).join(" "),
    bbl: bblOf(x),
    bin: x.bin ?? null,
    kind: kindOf(x),
    status: x.filing_status ?? "—",
    filingDate: x.filing_date ? String(x.filing_date).slice(0, 10) : null,
    // Absent stays absent. `Number(undefined) || 0` published 0 proposed units
    // for every demolition filing, which carries no unit count at all — the
    // original publishes null there (measured on 1008310026, 1008050097,
    // 3020000035 and 3018500044), and a demolition that "proposes 0 units" is
    // a different claim from one that proposes none.
    proposedUnits: x.proposed_dwelling_units == null ? null : Number(x.proposed_dwelling_units) || 0,
    proposedSf: x.total_construction_floor_area == null ? null : Number(x.total_construction_floor_area) || 0,
    applicant: x.applicant_business_name
      || [x.applicant_first_name, x.applicant_last_name].filter(Boolean).join(" ")
      || "—",
    owner: [x.owner_first_name, x.owner_last_name].filter(Boolean).join(" ") || x.owner_s_business_name || "—"
  };
}

router.get("/api/pipeline", async (req, res, next) => {
  if (req.query.zips === undefined) return next();
  const zips = zipsFrom(req.query.zips);
  // Measured: ?zips=, ?zips=abc and ?zips=1121 all answer
  //   400 {"error":"Provide ZIPs via ?zips="}
  // while ?zips=11216,abc answers 200 for 11216 alone.
  if (!zips.length) return res.status(400).json({ error: "Provide ZIPs via ?zips=" });

  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - WINDOW_MONTHS);
  const params = {
    $where: `postcode in (${zips.map((z) => `'${z}'`).join(",")}) and filing_date > '${since.toISOString().slice(0, 19)}' ` +
      "and (job_type='New Building' or full_demolition_work_type_='YES' or foundation_work_type_='YES')",
    $select: PIPELINE_SELECT,
    $order: "filing_date DESC",
    $limit: ROW_LIMIT
  };
  const r = await soql(DOB_NOW, params);
  if (!r.live) return res.status(503).json({ provenance: "unavailable", error: r.error || "dob_now_unavailable" });

  const rows = r.rows || [];
  let newBuilding = 0, foundation = 0, demolition = 0, proposedUnits = 0;
  for (const x of rows) {
    const kind = kindOf(x);
    if (kind === "New Building") { newBuilding += 1; proposedUnits += Number(x.proposed_dwelling_units) || 0; }
    else if (kind === "Demolition") demolition += 1;
    else foundation += 1;
  }

  // Sites are deduplicated on BBL + kind, keeping the first row of each pair —
  // the rows arrive filing_date DESC, so that is the most recent filing for
  // that lot and work type. Solved against the original: on ZIP 10001 that
  // reduces 114 rows to exactly its 45 sites and on 11216 the first 60 of 117
  // are exactly its 60, both in the same order. Deduplicating on bbl alone
  // (40 / 108), bin (42 / 118), bin+kind (47 / 125), address+kind (48 / 123) or
  // the base filing number (47 / 127) each reproduce neither.
  const seen = new Set();
  const sites = [];
  for (const x of rows) {
    const site = siteOf(x);
    const key = `${site.bbl}|${site.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push(site);
    if (sites.length >= SITE_LIMIT) break;
  }

  return res.json({
    zips,
    fetchedAt: new Date().toISOString(),
    windowMonths: WINDOW_MONTHS,
    counts: { newBuilding, foundation, demolition, proposedUnits },
    sites,
    coverage: `${n(newBuilding)} new-building, ${n(foundation)} foundation, and ${n(demolition)} demolition filings in ZIP ${zips.join(", ")} over the last ${WINDOW_MONTHS} months (DOB NOW). ${n(proposedUnits)} proposed units in the new-building pipeline.`,
    sources: [{
      id: "dob_now_pipeline",
      label: "DOB NOW Build (NB / foundation / demolition)",
      endpoint: DOB_NOW,
      query: sourceUrl(DOB_NOW, params),
      status: "ok",
      count: rows.length
    }]
  });
});

export default router;
