// Live data services — assembles real NYC public records (adapters/nyc.js)
// into the response shapes the frontend consumes. Every payload carries
// provenance:"live". When a pull fails, callers fall back to the clearly
// labeled demo engine — synthetic data is never presented as live.
import {
  parseBbl, plutoByBbl, plutoSearchAddress, plutoByZips, plutoCountByZips, plutoBbox, plutoBboxAll,
  plutoRowToBuilding, acrisByLot, rollingSalesByLot, rollingSalesByZips, parseSalesNum,
  dobPermitsByLot, dobNowByLot, dobNowByZips, hpdViolationsByBbl, ecbByLot, s311ByAddress, s311ByBbl,
  hpdContactsByBbl, taxHistoryByBbl, lienSaleByLot, zapByLot, ll84ByBbl, subwayStations, acsByZip,
  dobPermitContactsByLot, nysDosByName, NYS_DOS_DATASET, DS
} from "./adapters/nyc.js";
import { computePropensity, estimateDebtMaturity, computeDistressFromRecord } from "./scoring.js";
import { haversineFt } from "./util.js";

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const day = (v) => (v ? String(v).slice(0, 10) : null);

// ---------------------------------------------------------------- parcel core
export async function liveBuilding(bbl) {
  const r = await plutoByBbl(bbl);
  if (!r.live || !r.rows.length) return null;
  const b = plutoRowToBuilding(r.rows[0]);
  const prop = computePropensity(b);
  b.propensity = prop.score;
  b.propensityWhy = prop.components.slice(0, 2).map((c) => c.label).join(" · ");
  b.score = devScoreFromReal(b);
  return b;
}

// The one development score in this codebase.
//
// It is a MODELED ESTIMATE, and it is labelled as one everywhere it surfaces
// (`scoreValueType: "modeled estimate"` plus a `scoreBasis` naming the fit on
// /api/opportunities). The original's server-side scorer was never recovered —
// its own feed disproves the client formula, scoring catalyst-free parcels up to
// 98 — so what follows is a least-squares fit over the 150-parcel feed the
// original publishes.
//
// WHY THIS REPLACED THE EARLIER HEURISTIC (kept below, unused, as the record of
// what it was). The earlier version weighted borough, assessment land-share and
// unused-FAR scale. Both were measured against the original's own scores on the
// same lots, 2026-08-18:
//
//   72 territory top-lots across 11216 and 10001   mean |error|
//     earlier heuristic                              6.63
//     this fit                                       2.32
//   800 area-buildings rows across the same ZIPs   median |error|
//     earlier heuristic                             13
//     this fit                                       7
//
// It also settles a divergence that mattered more than the arithmetic: the
// original reports ONE score per lot — /api/area-buildings and /api/territory
// both answer 30 for BBL 3018420015 — while this codebase had two scorers, so
// the inventory list and the territory drill-down disagreed about the same
// building. Every surface now calls this function.
const clamp01 = (n) => Math.max(0, Math.min(1, n));

// The original's development score, RECOVERED — not fitted.
//
// Everything above this line describes two successive least-squares fits. Both
// are gone: the rule itself was solved on 2026-08-19 and it reproduces the
// original EXACTLY. Verified against 2,000 scored lots collected from the
// original's own /api/area-buildings across ten ZIPs (11216, 10001, 10002,
// 10451, 11101, 10314, 11375, 10035, 11221, 10024):
//
//   shipped fit          280/2000 exact (14.0%)
//   refit, same basis    423/2000 exact (21.1%)
//   fit + interactions   483/2000 exact (24.1%)   MAE 1.73
//   THIS RULE           2000/2000 exact (100.0%)  MAE 0.0000  max error 0
//
// Four capped components over published PLUTO fields, summed and rounded ONCE.
// The maximum attainable is exactly 100 (60 + 20 + 10 + 10).
//
//   envelope, up to 60
//     maxFar   = max(residfar, commfar, facilfar)
//     unusedFar = maxFar - builtfar            (may be negative on an overbuilt lot)
//     share     = clamp01(unusedFar / maxFar)
//     BOTH gates are STRICT: 60 x share only when unusedFar > 1 AND share > 0.5,
//     otherwise 45 x share. Boundary lots the original itself publishes pin
//     this — 27 lots at share exactly 0.5 and 363 lots at unusedFar exactly 1.0
//     all take the 45-band, which excludes ">=".
//   lot size, up to 20   20 x clamp01(log10(1+lotarea) / log10(1+20,000))
//     saturates at 20,000 sf.
//   assessed value, up to 10
//     10 x clamp01(log10(1+assesstot) / log10(1+50,000,000))
//     assesstot, NOT assessland; saturates at $50m.
//   age, up to 10
//     yearbuilt 0 (unknown) takes a fixed 0.6; a year at or below 1800 is a bad
//     record and contributes 0; otherwise clamp01(((NOW - yearbuilt) - 26)/120),
//     i.e. 0 at yearbuilt >= 2000 and 1 at yearbuilt <= 1880.
//
// ONE RESIDUAL AMBIGUITY, stated honestly: every measurement was taken on
// 2026-08-19, so ((NOW - yearbuilt) - 26)/120 and a hard-coded
// (2000 - yearbuilt)/120 are observationally identical today. They diverge on
// 1 January 2027. The NOW-relative form is used because every other age term in
// this codebase is NOW-relative; if the original turns out to be the fixed form,
// this is the one line to change.
const SCORE_NOW_YEAR = new Date().getUTCFullYear();
const log10p1 = (x) => Math.log10(1 + Math.max(0, x));
const LOT_SATURATION_SF = 20000;
const ASSESS_SATURATION = 50000000;
const LOT_REF = log10p1(LOT_SATURATION_SF);
const ASSESS_REF = log10p1(ASSESS_SATURATION);
const AGE_FLOOR_YEARS = 26;
const AGE_SPAN_YEARS = 120;
const AGE_UNKNOWN_SHARE = 0.6;
const scoreNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function devScoreFromReal(b) {
  const maxFar = scoreNum(b?.maxFar);
  // `far` is the opportunities vocabulary, `builtFar` the building vocabulary.
  const builtFar = scoreNum(b?.builtFar ?? b?.far);

  let envelope = 0;
  if (maxFar > 0) {
    const unusedFar = maxFar - builtFar;
    const share = clamp01(unusedFar / maxFar);
    envelope = (unusedFar > 1 && share > 0.5) ? 60 * share : 45 * share;
  }
  const size = 20 * clamp01(log10p1(scoreNum(b?.lotArea ?? b?.lotSf)) / LOT_REF);
  const assess = 10 * clamp01(log10p1(scoreNum(b?.assessTotal)) / ASSESS_REF);
  const yearBuilt = scoreNum(b?.yearBuilt);
  const ageShare = yearBuilt
    ? (yearBuilt > 1800 ? clamp01(((SCORE_NOW_YEAR - yearBuilt) - AGE_FLOOR_YEARS) / AGE_SPAN_YEARS) : 0)
    : AGE_UNKNOWN_SHARE;

  return Math.round(envelope + size + assess + 10 * ageShare);
}

// The heuristic this replaced, retained so the change is legible and reversible.
// Nothing calls it.
export function devScoreHeuristicSuperseded(b) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const density = b.maxFar > 0 ? clamp((b.maxFar - b.builtFar) / b.maxFar, 0, 1) : 0;
  const scale = clamp((b.unusedFarSf ?? 0) / 120000, 0, 1);
  const age = b.yearBuilt ? clamp((new Date().getFullYear() - b.yearBuilt) / 120, 0, 1) : 0.5;
  const landShare = b.assessTotal ? clamp(b.assessLand / b.assessTotal, 0, 1) : 0.3;
  const boroW = { Manhattan: 0.9, Brooklyn: 0.75, Queens: 0.6, Bronx: 0.5, "Staten Island": 0.45 }[b.borough] ?? 0.5;
  return Math.round(clamp(22 * (0.6 * density + 0.4 * scale) + 16 * age + 14 * landShare + 18 * boroW + 22 * Math.min(density + landShare, 1) * 0.5 + 8, 5, 99));
}

export async function liveAddressSearch(q) {
  const digits = String(q).replace(/[^0-9]/g, "");
  if (digits.length === 10) {
    const b = await liveBuilding(digits);
    return b ? [b] : [];
  }
  const r = await plutoSearchAddress(q);
  if (!r.live) return null;
  return r.rows.map(plutoRowToBuilding);
}

// ---------------------------------------------------------------- asset history
export async function liveAssetHistory(bbl) {
  const b = await liveBuilding(bbl);
  if (!b) return null;
  const [acris, salesR, permitsR, dobNowR, hpdR, tax] = await Promise.all([
    acrisByLot(bbl), rollingSalesByLot(bbl), dobPermitsByLot(bbl), dobNowByLot(bbl),
    hpdViolationsByBbl(bbl), taxHistoryByBbl(bbl)
  ]);

  // Sales chain: recorded deeds (with parties where pulled) + rolling sales prices.
  const sales = (acris.deeds ?? []).map((d) => {
    const pr = acris.parties?.[d.document_id] ?? [];
    const grantor = pr.filter((p) => p.party_type === "1").map((p) => p.name).join("; ");
    const grantee = pr.filter((p) => p.party_type === "2").map((p) => p.name).join("; ");
    return {
      // Recorded date, matching the dossier and the original site. See the note
      // in server/production-dossier.js: document_date is when the deed was
      // signed, recorded_datetime is when it became a public record, and it is
      // the second one every consumer of this field means.
      date: day(d.recorded_datetime || d.document_date),
      documentDate: day(d.document_date),
      amount: num(d.document_amt) || 0,
      grantor: grantor || "—", grantee: grantee || "—",
      docId: d.document_id, docType: d.doc_type
    };
  });
  for (const s of salesR.rows ?? []) {
    const price = num(s.sale_price);
    if (price > 0 && !sales.some((x) => x.date === day(s.sale_date))) {
      sales.push({ date: day(s.sale_date), amount: price, grantor: "—", grantee: "—", docId: null, docType: "ROLLING SALE" });
    } else if (price > 0) {
      const hit = sales.find((x) => x.date === day(s.sale_date));
      if (hit && !hit.amount) hit.amount = price;
    }
  }
  sales.sort((a, z) => String(z.date ?? "").localeCompare(String(a.date ?? "")));

  const loans = (acris.mortgages ?? []).map((m) => {
    const pr = acris.parties?.[m.document_id] ?? [];
    const lender = pr.filter((p) => p.party_type === "2").map((p) => p.name).join("; ");
    return {
      date: day(m.recorded_datetime || m.document_date),
      documentDate: day(m.document_date),
      amount: num(m.document_amt) || 0,
      docType: m.doc_type, lender: lender || "—", docId: m.document_id
    };
  });

  const permits = (permitsR.rows ?? []).map((x) => ({
    date: day(x.issuance_date) ?? day(x.filing_date),
    type: `${x.job_type ?? ""}${x.work_type ? ` — ${x.work_type}` : ""}`.trim() || "—",
    status: x.permit_status ?? "—",
    applicant: [x.permittee_s_first_name, x.permittee_s_last_name].filter(Boolean).join(" ") || x.permittee_s_business_name || "—",
    phone: x.permittee_s_phone__ || null,
    business: x.permittee_s_business_name ?? null
  }));
  b.permitCount = permits.length;

  const last = sales.find((s) => s.amount > 0) ?? sales[0] ?? null;
  const metrics = last
    ? {
        lastSalePrice: last.amount || null, lastSaleDate: last.date,
        lastSalePpsf: last.amount && b.bldgArea ? Math.round(last.amount / b.bldgArea) : null,
        holdYears: last.date ? Math.max(0, Math.round(((Date.now() - new Date(last.date)) / (365.25 * 864e5)) * 10) / 10) : null
      }
    : { lastSalePrice: null, lastSaleDate: null, lastSalePpsf: null, holdYears: null };

  // Real market value from the assessment roll (current year row).
  // marketValue is already null when absent, but null-from-outage and
  // null-from-no-assessment are different claims and the caller could not tell
  // them apart. The value is unchanged; the reason is now recoverable.
  const taxLive = tax?.live !== false;
  const taxRow = taxLive ? (tax.rows ?? []).find((r) => num(r.curmkttot) > 0 || num(r.pymkttot) > 0) : null;
  const marketValue = taxRow ? (num(taxRow.curmkttot) || num(taxRow.pymkttot)) : null;
  b.marketValue = marketValue;

  // A violation count of zero must mean "the record shows none", never "the
  // source did not answer".
  //
  // `(hpdR.rows ?? []).length` published hpdViolations: 0 whenever the HPD
  // dataset was unreachable, and computeDistressFromRecord() reads exactly that
  // field: a building with a hundred open violations scored as clean during an
  // outage, and the dossier printed "0 open violations" about a real address.
  // Null is the honest value for unknown, and every consumer already treats a
  // nullish signal as absent rather than as zero.
  const hpdLive = hpdR?.live !== false;
  const hpdOpen = hpdLive
    ? (hpdR.rows ?? []).filter((v) => /open/i.test(v.violationstatus ?? v.currentstatus ?? "")).length
    : null;

  // The five nearest buildings of the same class family in the same ZIP.
  //
  // This shipped as a hard-coded `competitiveSet: []`, so the dossier's peer
  // panel was empty on every live parcel while the original returns five — for
  // 1008350041 it leads with 4 WEST 33 STREET, 0.04 mi away. It is the panel an
  // underwriter reads to sanity-check floor count, vintage and scale before
  // trusting a comp, so an empty one is not a cosmetic gap.
  //
  // Every field is PLUTO as published. Distance is straight-line between the two
  // published centroids and is labeled as a distance, not as walking or driving
  // time — nothing here is modeled or estimated.
  const competitiveSet = await liveCompetitiveSet(b);

  return {
    provenance: "live",
    bbl: b.bbl, address: b.address,
    pluto: {
      zip: b.zip, owner: b.owner, mailAddress: null, zoning: b.zoning, bldgClass: b.bldgClass,
      landUse: b.landUse, yearBuilt: b.yearBuilt || null, yearAlter1: b.yearAlter1 ?? null, yearAlter2: b.yearAlter2 ?? null,
      unitsRes: b.unitsRes, unitsTotal: b.unitsTotal, lotArea: b.lotArea, bldgArea: b.bldgArea,
      builtFar: b.builtFar, maxFar: b.maxFar, numFloors: b.numFloors, lat: b.lat, lng: b.lng, neighborhood: null
    },
    metrics, sales, loans, permits,
    // An empty filing list from a DOB NOW outage reads as "no work filed on
    // this building", which is a claim about the property. Null says only that
    // it could not be established.
    dobNow: dobNowR?.live === false ? null : (dobNowR.rows ?? []).map((x) => ({
      date: day(x.filing_date), type: x.job_type ?? "—", status: x.filing_status ?? "—",
      applicant: [x.applicant_first_name, x.applicant_last_name].filter(Boolean).join(" ") || "—"
    })),
    comps: [], competitiveSet,
    // assessImprovements is not a separate published field: DOF publishes land
    // and total, and the improvement value is the difference. Returning null
    // where the original returns 478,440,900 made the dossier look like the
    // number was unavailable when both of its inputs were already in hand.
    // exemptTotal comes straight from PLUTO's `exempttot`, which was selected
    // and then discarded in plutoRowToBuilding.
    assessment: taxRow ? (() => {
      const total = num(taxRow.curacttot) || num(taxRow.pyacttot) || b.assessTotal;
      return {
        assessTotal: total,
        assessLand: b.assessLand,
        assessImprovements: Number.isFinite(total) && Number.isFinite(b.assessLand) ? total - b.assessLand : null,
        exemptTotal: b.exemptTotal ?? null
      };
    })() : {
      assessTotal: b.assessTotal, assessLand: b.assessLand,
      assessImprovements: b.assessTotal - b.assessLand,
      exemptTotal: b.exemptTotal ?? null
    },
    signals: {
      hpdViolations: hpdOpen,
      dobViolations: null,
      hpd: {
        open: hpdOpen,
        total: hpdLive ? (hpdR.rows ?? []).length : null,
        heatOpen: null,
        // Distinguishes "the record shows none" from "HPD did not answer".
        // Without this the two are the same JSON.
        ...(hpdLive ? {} : { status: "unavailable", reason: hpdR?.error ?? "HPD violations source did not answer" })
      },
      ecb: null, threeOneOne: null,
      provenance: "live"
    },
    building: b
  };
}

// Peer set: nearest same-class-family buildings in the same ZIP, by published
// centroid distance. Returns [] rather than throwing — a peer panel is context,
// and an outage in it must not take the whole dossier down with it.
// haversineFt, not a flat-earth approximation. Two peers 0.05 mi away round to
// the same displayed distance, so the ORDER is decided entirely by the
// underlying number — and an equirectangular approximation put 1 WEST 34 STREET
// and 330 5 AVENUE in the opposite order to the original. haversineFt is the
// function the rest of this codebase already ranks by, rounded to whole feet the
// same way, so the tie breaks identically.
export async function liveCompetitiveSet(b, limit = 5) {
  if (!b?.zip || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return [];
  const fam = String(b.bldgClass ?? "")[0] ?? "";
  try {
    const r = await plutoByZips([b.zip], { limit: 800 });
    if (!r.live) return [];
    const peers = (r.rows ?? [])
      .map(plutoRowToBuilding)
      .filter((x) => x.bbl && x.bbl !== b.bbl && Number.isFinite(x.lat) && Number.isFinite(x.lng))
      .filter((x) => (fam ? String(x.bldgClass ?? "")[0] === fam : true))
      .map((x) => ({ x, ft: haversineFt(b.lat, b.lng, x.lat, x.lng) }))
      .sort((p, q) => p.ft - q.ft)
      .slice(0, limit);
    return peers.map(({ x, ft }) => ({
      address: x.address,
      bbl: x.bbl,
      distanceMi: Math.round((ft / 5280) * 100) / 100,
      yearBuilt: x.yearBuilt || null,
      yearAlter1: x.yearAlter1 ?? null,
      numFloors: x.numFloors,
      bldgArea: x.bldgArea,
      units: x.unitsTotal,
      bldgClass: x.bldgClass,
      lat: x.lat, lng: x.lng
    }));
  } catch {
    return [];
  }
}

// Comps: recorded arm's-length sales in the same ZIP + class family, 24 months.
export async function liveComps(b) {
  if (!b?.zip) return [];
  const r = await rollingSalesByZips([b.zip], { limit: 220 });
  if (!r.live) return null;
  const fam = (b.bldgClass ?? "")[0];
  const cutoff = Date.now() - 24 * 30.4 * 864e5;
  const recent = (r.rows ?? [])
    .filter((s) => new Date(s.sale_date).getTime() > cutoff)
    .filter((s) => num(s.sale_price) > 10000);
  // Same class family first; when the class is thin in this ZIP (a boutique
  // hotel, a one-off industrial lot), widen to income-property classes and
  // then to every recorded sale — production always shows a ZIP comp median.
  const cls = (s) => (s.building_class_at_present ?? "")[0];
  let pool = recent.filter((s) => cls(s) === fam);
  if (pool.length < 3) pool = recent.filter((s) => "CDSROH".includes(cls(s)));
  if (pool.length < 3) pool = recent;
  return pool
    .slice(0, 8)
    .map((s) => ({
      date: day(s.sale_date), address: s.address, bldgClass: s.building_class_at_present,
      price: num(s.sale_price),
      ppsf: parseSalesNum(s.gross_square_feet) ? Math.round(num(s.sale_price) / parseSalesNum(s.gross_square_feet)) : null,
      bbl: s.borough && s.block && s.lot ? `${s.borough}${String(s.block).padStart(5, "0")}${String(s.lot).padStart(4, "0")}` : null
    }));
}

// ---------------------------------------------------------------- contacts (real only — audit #35)
// The dossier's contact panel, transcribed from the original's own response.
//
// WHAT WAS WRONG. Measured against nycremarketintel.com for BBL 1008350041 on
// 2026-08-18, every permit contact this returned had name, business, phone,
// license and date all null, and `role` carried a DOB work-type code ("MH")
// where the original carries the constant "Permittee / contractor". Four
// independent causes:
//
//   1. No permittee filter. Rows that carry no permittee at all were pushed,
//      and their dedupe key collapsed to the same literal for every one of
//      them, so exactly one all-null row survived and was published.
//   2. `date: day(x.issuance_date)` with no fallback. Twelve of the fifty rows
//      in this parcel's window have a null issuance_date, and Socrata sorts
//      nulls FIRST on `$order=issuance_date DESC`, so they lead the window and
//      every one published date:null. The original falls back to filing_date —
//      its top three rows read 02/12/2016, 03/23/2006, 08/20/2003, which are
//      those rows' filing dates, while a row that HAS an issuance date
//      publishes it (12/31/1997 over a 12/29/1997 filing).
//   3. `role` read a work-type column the original never reads.
//   4. The window was capped at 8 contacts where the original publishes 24.
//
// And `ownerEntities` was being derived from HPD building registrations, which
// answer a different question: the original searches NEW YORK STATE's corporate
// registry for the owner's business name and returns the LLCs with their
// registered mailing addresses, county and DOS id. That is the panel's point —
// it is how a broker reaches a shell owner — and it was empty for every lot
// without an HPD registration.
// COMPANY and LTD are NOT stripped, and TRUST/ASSOCIATES are not either.
// Measured 2026-08-20 on the original's own NYS DOS source labels:
//   "Empire State Building Co. LLC"  -> "EMPIRE STATE BUILDING"      (CO., LLC out)
//   "THE CRENULATED COMPANY LTD."    -> "THE CRENULATED COMPANY LTD" (only the ".")
//   "NATIONAL RAILROAD PASS.CORP."   -> "NATIONAL RAILROAD PASS"     (CORP. out)
// Stripping COMPANY/LTD as well produced "THE CRENULATED", which searches the
// registry for the wrong entity.
const CORP_SUFFIX = /[\s,.]*\b(?:L\.?L\.?C\.?|INC\.?|CORP\.?|CORPORATION|CO\.?|L\.?P\.?|LLP|PLLC)\b[\s,.]*$/i;
// The registry search term the original uses. Its own source label for BBL
// 1008350041 reads `NYS DOS corp registry ("EMPIRE STATE BUILDING")`, and the
// three owner businesses on that parcel's permits are "EMPIRE STATE BUILDING
// CO. LLC", "Empire State Building Co. LLC" and "EMPIRE STATE BUILDING".
// Stripping corporate suffixes collapses all three to that term.
// The FIRST owner business, not the most frequent. Measured 2026-08-20 against
// the original's own source labels: on 2028450001 the businesses in published
// order are "THE CRENULATED COMPANY LTD.", "OUTDOOR INSTALLATIONS, LLC",
// "CRENULATED CO LTD", ... and the original searches "THE CRENULATED COMPANY
// LTD" — the first one. Frequency ranking chose a different string there.
// countsSuperseded is kept beside it with the measurement that replaced it.
function registrySearchTerm(businesses) {
  for (const b of businesses) {
    let t = String(b ?? "").toUpperCase().replace(/\s+/g, " ").trim();
    if (!t) continue;
    let prev = null;
    while (prev !== t) { prev = t; t = t.replace(CORP_SUFFIX, "").replace(/[\s,.]+$/, "").trim(); }
    if (t.length < 4) continue;
    return t;
  }
  return "";
}
// Superseded 2026-08-20 (see registrySearchTerm): ranked candidates by how
// often they appeared, then by shortest. On 2028450001 that answered
// "CRENULATED CO LTD" reduced, not the original's "THE CRENULATED COMPANY LTD".
function registrySearchTermByFrequencySuperseded(businesses) {
  const counts = new Map();
  for (const b of businesses) {
    let t = String(b ?? "").toUpperCase().replace(/\s+/g, " ").trim();
    if (!t) continue;
    let prev = null;
    while (prev !== t) { prev = t; t = t.replace(CORP_SUFFIX, "").trim(); }
    if (t.length < 4) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (!counts.size) return "";
  return [...counts].sort((a, z) => z[1] - a[1] || a[0].length - z[0].length)[0][0];
}

export async function liveContacts(bbl) {
  const [hpd, permitsR, acris] = await Promise.all([
    hpdContactsByBbl(bbl), dobPermitContactsByLot(bbl), acrisByLot(bbl)
  ]);
  if (!hpd.live && !permitsR.live && !acris.live) return null;
  const p = parseBbl(bbl);

  // ---- permittees, straight off the DOB filing
  //
  // WHY THE BIGGEST TOWERS STILL DIFFER FROM THE ORIGINAL, and why there is
  // nothing here to fix. Measured 2026-08-20.
  //
  // Both sides issue the IDENTICAL query — the original publishes it in its own
  // sources[0] and it matches this one byte for byte:
  //   ipu4-2q9a.json?bbl=1008350041&$limit=50&$order=issuance_date DESC
  // and both report count 50. But `issuance_date` is a TEXT column holding
  // MM/DD/YYYY, so DESC sorts it LEXICOGRAPHICALLY: every 12/31/xxxx sorts
  // above every 11/xx/xxxx regardless of year, and 12 of this lot's 3,402
  // permits carry no issuance_date at all. The window is therefore one enormous
  // tie, and Socrata does not order within it:
  //
  //   distinct 50-row orders over 5 identical requests: 2
  //     run0..run3  first row owner "Empire State Building Co. LLC"
  //     run4        first row owner "EMPIRE STATE BUILDING COMPANY"
  //
  // So on a lot with far more than 50 permits the two sides legitimately see
  // different rows, and permitContacts, ownerContacts and the mortgage
  // debtParties reads all follow. Nine of twelve probed lots are byte-identical;
  // the three that are not (1008350041, 1000160010, 2028450001) are the ones
  // with the deepest permit history. This is the same upstream nondeterminism
  // already recorded for equal-assesstot ties in /api/opportunities, and any
  // deterministic tiebreak invented here would disagree with the original
  // roughly as often as it agreed.
  const permitContacts = [];
  const seen = new Set();
  for (const x of permitsR.rows ?? []) {
    const name = [x.permittee_s_first_name, x.permittee_s_last_name].filter(Boolean).join(" ") || null;
    const business = x.permittee_s_business_name ?? null;
    // A filing with no permittee is not a contact. Publishing it produced the
    // all-null row.
    if (!name && !business) continue;
    const key = `${name ?? ""}|${business ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    permitContacts.push({
      role: "Permittee / contractor",
      name, business,
      phone: x.permittee_s_phone__ || null,
      // `license` is omitted when the filing carries none — the original's
      // permitContacts[19] on 1008350041 is
      //   [role, name, business, phone, source, date]
      // with no `license` key, where the rebuild published license: null.
      ...(x.permittee_s_license__ ? { license: x.permittee_s_license__ } : {}),
      source: "DOB BIS permit",
      // Verbatim, not normalised: this dataset publishes MM/DD/YYYY and the
      // original passes it through.
      date: x.issuance_date || x.filing_date || null
    });
  }

  // ---- the owner side of the same filings
  const ownerContacts = [];
  const seenOwners = new Set();
  for (const x of permitsR.rows ?? []) {
    const name = [x.owner_s_first_name, x.owner_s_last_name].filter(Boolean).join(" ") || null;
    const business = x.owner_s_business_name ?? null;
    if (!name && !business) continue;
    const key = `${name ?? ""}|${business ?? ""}`;
    if (seenOwners.has(key)) continue;
    seenOwners.add(key);
    ownerContacts.push({
      role: "Owner of record (DOB filing)",
      name, business,
      source: "DOB BIS permit (owner)",
      date: x.issuance_date || x.filing_date || null
    });
  }
  // The original publishes 12 owner rows and 10 names; the permittee list is
  // uncapped within the 50-row source window (24 rows for BBL 1008350041).
  ownerContacts.length = Math.min(ownerContacts.length, 12);
  const ownerNames = ownerContacts.slice(0, 10).map((o) => ({ name: o.name, business: o.business }));

  // ---- HPD building registration contacts
  // WHICH registration roles, in WHAT order, and with WHAT keys — all measured
  // 2026-08-20 against the original on six lots.
  //
  // ROLES. HPD's own vocabulary maps to the original's labels like this, and
  // SiteManager is dropped: BBL 3011370001's registration carries
  // [IndividualOwner, SiteManager] and the original publishes one row, the
  // owner. 2028450001 carries [SiteManager, CorporateOwner, HeadOfficer, Agent]
  // and the original publishes three — everything except the site manager.
  //
  // ORDER. Not the source order. On 2028450001 the source runs SiteManager,
  // CorporateOwner, HeadOfficer, Agent and the original publishes Managing
  // agent, Corporate owner, Head officer; four further registrations
  // (2038610162, 2053120091, 2037920052 and one more) each run
  // [IndividualOwner, Agent, SiteManager] in the source and each publish
  // "Managing agent , Owner". So the agent leads, the owners follow, the head
  // officer is last. Ranks are equal for the two owner types, and the sort is
  // stable, so their source order decides between them.
  //
  // KEYS. A key the row has no value for is OMITTED, not published as null:
  // 3011370001 ships [role, name, source, date] with no `business`, and
  // 2028450001's corporate owner ships [role, business, source, date] with no
  // `name`.
  //
  // `date` CARRIES THE BUSINESS ADDRESS. That is the original's own defect —
  // a date field holding "575 CARLTON AVE Brooklyn NY 11238" — and the rebuild
  // used to correct it by publishing an `address` key and leaving `date` null.
  // The specification is the original, so the defect is reproduced: `date` holds
  // the address string and there is no `address` key.
  const HPD_ROLE = { agent: "Managing agent", corporateowner: "Corporate owner", individualowner: "Owner", headofficer: "Head officer (co-op/owner)" };
  const HPD_RANK = { agent: 0, corporateowner: 1, individualowner: 1, headofficer: 2 };
  const hpdContacts = (hpd.rows ?? [])
    .map((c, i) => ({ c, i, key: String(c.type ?? "").toLowerCase().replace(/[^a-z]/g, "") }))
    .filter((x) => x.key in HPD_RANK)
    .sort((a, b) => HPD_RANK[a.key] - HPD_RANK[b.key] || a.i - b.i)
    .map(({ c, key }) => {
      const name = [c.firstname, c.lastname].filter(Boolean).join(" ") || null;
      const business = c.corporationname ?? null;
      const address = [c.businesshousenumber, c.businessstreetname, c.businessapartment, c.businesscity, c.businessstate, c.businesszip]
        .filter(Boolean).join(" ") || null;
      return {
        role: HPD_ROLE[key],
        ...(name ? { name } : {}),
        ...(business ? { business } : {}),
        source: "HPD registration",
        // `date` is omitted too when the registration carries no business
        // address: 2053120091's managing-agent row is exactly
        // [role, name, source] on the original.
        ...(address ? { date: address } : {})
      };
    })
    .slice(0, 12);

  // ---- NYS corporate registry, searched on the owner's business name
  const term = registrySearchTerm(ownerContacts.map((o) => o.business));
  const dos = term ? await nysDosByName(term).catch(() => ({ live: false, rows: [], error: "nys_dos_unavailable" })) : { live: false, rows: [], skipped: true };
  const ownerEntities = (dos.rows ?? []).map((r) => ({
    entityName: r.current_entity_name ?? null,
    entityType: r.entity_type ?? null,
    address: [r.dos_process_address_1, r.dos_process_city, r.dos_process_state, r.dos_process_zip].filter(Boolean).join(", ") || null,
    county: r.county ?? null,
    dosId: r.dos_id ?? null
  }));

  // ---- the recorded mortgage's counterparties
  // The TWO counterparties of the current mortgage, borrower first — measured
  // 2026-08-20 on six lots. The original publishes exactly one party_type 1 row
  // and one party_type 2 row, in that order:
  //   1012650001  ["ROCKEFELLER CENTER INC", "EMIGRANT SAVINGS BANK"]
  //   4002140001  ["NATIONAL RAILROAD CORP",  "EXPORT DEVELOPMENT CORP"]
  // The rebuild published them in the record's own order — lender first on
  // every one of those lots — and published all of them, so 2037920052 carried
  // three rows where the original carries two (that instrument names both MERS
  // as nominee and the lender itself; the original keeps the first named).
  // `address` is omitted when the record carries none, the same
  // omit-when-absent rule the hpdContacts rows follow.
  // WHICH mortgage the panel reads. `acris.mortgages` arrives newest-first, so
  // this takes the newest — measured 2026-08-20 against the original's own
  // disclosed acris_parties query on nine lots: 7 of 9 agree.
  //
  // The two that do not are 1008350041 (original reads 2013031201548002, a $50M
  // mortgage recorded 2013-03-22, where the newest is 2013091000735002 at $31M
  // recorded 2013-10-02) and 2028450001 (original reads 2019032700486004, where
  // ...486002, ...486004 and ...486005 were all recorded in the same instant at
  // $24,425,000 / $24,425,000 / $19,985,760).
  //
  // Three rules were tested against those nine lots and rejected rather than
  // shipped:
  //   newest by recorded_datetime          7/9   <- kept
  //   largest document_amt                 6/9
  //   newest unsatisfied (ACRIS xref)      0/9   — the cross-reference marks
  //                                              every mortgage on all nine
  //                                              lots as satisfied, so this
  //                                              selects nothing at all
  // A document_id tiebreak was also tried and REVERTED: on 2028450001 lowest-id
  // picks ...486002 where the original picks ...486004, so it moved that lot
  // further from the original rather than closer.
  //
  // On 1008350041 the published debtParties are IDENTICAL either way — both
  // documents name the same borrower and lender — so only the disclosed query
  // string differs there. I do not know the exact cause of this yet.
  const debtParties = [];
  const mtge = (acris.mortgages ?? []).find((m) => m.kind === "mortgage");
  if (mtge) {
    const rows = acris.parties?.[mtge.document_id] ?? [];
    // ACRIS party_type 1 is the mortgagor, 2 the mortgagee. Anything else on
    // the instrument is neither, and labelling it "Lender" — which is what
    // mapping every non-1 to the lender role did — puts a name on the panel
    // under a role the record does not give it.
    for (const [t, role] of [["1", "Borrower / owner (ACRIS)"], ["2", "Lender (ACRIS)"]]) {
      const party = rows.find((x) => String(x.party_type ?? "") === t);
      if (!party) continue;
      const address = [party.address_1, party.address_2, party.city, party.state, party.zip].filter(Boolean).join(", ") || null;
      debtParties.push({ role, name: party.name, ...(address ? { address } : {}) });
    }
  }

  const SOC = "https://data.cityofnewyork.us/resource";
  const status = (r, rows) => (r?.skipped ? "skipped" : !r?.live ? "error" : rows.length ? "ok" : "empty");
  return {
    provenance: "live",
    permitContacts, ownerContacts, hpdContacts, ownerNames, ownerEntities, debtParties,
    sources: [
      {
        id: "dob_permits", label: "DOB Permit Issuance (contacts + phone)", endpoint: DS.dobPermits,
        query: `${SOC}/${DS.dobPermits}.json?${new URLSearchParams({ bbl: String(p?.digits ?? bbl), $limit: "50", $order: "issuance_date DESC" })}`,
        status: status(permitsR, permitsR.rows ?? []), count: (permitsR.rows ?? []).length
      },
      ...(term ? [{
        id: "nys_dos", label: `NYS DOS corp registry ("${term}")`, endpoint: NYS_DOS_DATASET,
        query: `https://data.ny.gov/resource/${NYS_DOS_DATASET}.json?${new URLSearchParams({ $where: `upper(current_entity_name) like '%${term}%'`, $limit: "6" })}`,
        status: status(dos, dos.rows ?? []), count: (dos.rows ?? []).length
      }] : []),
      {
        // The original publishes the REGISTRATION lookup here, select, order and
        // limit included, and counts the registrations it found — not the
        // contact rows on them. Measured on 3011370001: its query is
        //   tesw-yqqr.json?boroid=3&block=1137&lot=1
        //     &$select=registrationid, lastregistrationdate
        //     &$order=lastregistrationdate DESC&$limit=1
        // with count 1, where the rebuild published the bare lookup and count 2
        // (the two contacts on that registration).
        id: "hpd_reg", label: "HPD building registration (owner / managing agent)", endpoint: DS.hpdContacts,
        query: `${SOC}/${DS.hpdRegistrations}.json?${new URLSearchParams({
          boroid: String(p?.boro ?? ""), block: String(p?.block ?? ""), lot: String(p?.lot ?? ""),
          $select: "registrationid, lastregistrationdate", $order: "lastregistrationdate DESC", $limit: "1"
        })}`,
        // count is the number of rows this source CONTRIBUTES, i.e. the
        // published hpdContacts: 1 on 3011370001, 2 on 2053120091, 3 on
        // 2028450001 — not the raw contact rows on the registration.
        status: status(hpd, hpd.rows ?? []), count: hpdContacts.length
      },
      {
        id: "acris_parties", label: "ACRIS party addresses", endpoint: DS.acrisParties,
        // The original publishes its $select here too, measured on six lots:
        //   636b-3b5g.json?document_id=…&$select=document_id,party_type,name,address_1,city,state,zip&$limit=50
        query: mtge ? `${SOC}/${DS.acrisParties}.json?${new URLSearchParams({ document_id: mtge.document_id, $select: "document_id,party_type,name,address_1,city,state,zip", $limit: "50" })}` : "",
        // count is the raw party rows the query returned, not the two the panel
        // publishes: 2038610162 answers 5 and 2037920052 answers 3 on the
        // original, against two published counterparties on each.
        status: mtge ? status(acris, debtParties) : "skipped",
        count: mtge ? (acris.parties?.[mtge.document_id] ?? []).length : 0
      }
    ],
    note: "Live, free public-record contacts: DOB permit phones/names are public; NYS DOS gives the LLC's registered mailing address; ACRIS gives recorded party addresses. Small shell LLCs may not resolve — these are leads, not verified direct lines."
  };
}

// ---------------------------------------------------------------- distress
export async function liveDistress(bbl, address, zip) {
  // BBL, not address: 311's incident_address does not match PLUTO's address
  // string, so the address form silently returned zero complaints. See
  // s311ByBbl in adapters/nyc.js for the counts that proved it.
  const [hpd, ecb, three] = await Promise.all([hpdViolationsByBbl(bbl), ecbByLot(bbl), s311ByBbl(bbl)]);
  if (!hpd.live && !ecb.live) return null;
  const hpdRows = hpd.rows ?? [];
  const openHpd = hpdRows.filter((v) => /open/i.test(v.violationstatus ?? v.currentstatus ?? ""));
  const ecbRows = ecb.rows ?? [];
  const balance = ecbRows.reduce((n, r) => n + (num(r.balance_due) || 0), 0);
  const unresolved = ecbRows.filter((r) => !/resolve/i.test(r.ecb_violation_status ?? "")).length;
  const t311 = three.rows ?? [];
  const heat = t311.filter((c) => /heat|hot water/i.test(c.complaint_type ?? ""));
  const byType = {};
  for (const c of t311) byType[c.complaint_type] = (byType[c.complaint_type] ?? 0) + 1;
  return {
    provenance: "live",
    hpdViolations: openHpd.length,
    dobViolations: unresolved,
    hpd: { open: openHpd.length, total: hpdRows.length, heatOpen: heat.length ? heat.length : 0 },
    ecb: { balanceDue: Math.round(balance), unresolved },
    threeOneOne: {
      total12mo: t311.length,
      heatHotWater12mo: heat.length,
      topCategories: Object.entries(byType).sort((a, z) => z[1] - a[1]).slice(0, 3).map(([type, n]) => ({ type, n }))
    }
  };
}

// ---------------------------------------------------------------- taxes
export async function liveTaxHistory(bbl) {
  const r = await taxHistoryByBbl(bbl);
  if (!r.live) return null;
  const rows = (r.rows ?? []).map((x) => {
    const year = parseInt(x.year, 10);
    const market = num(x.curmkttot) ?? num(x.pymkttot);
    const assessed = num(x.curacttot) ?? num(x.pyacttot);
    const taxable = num(x.curtxbtot) ?? num(x.pytxbtot);
    const cls = x.curtaxclass ?? x.pytaxclass ?? null;
    const rate = { 1: 0.20085, 2: 0.12502, 3: 0.11891, 4: 0.10646 }[String(cls ?? "").replace(/[^0-9]/g, "")[0]] ?? 0.125;
    return { year, taxClass: cls, marketValue: market, assessedTotal: assessed, taxable, estTax: taxable ? Math.round(taxable * rate) : null };
  }).filter((x) => x.marketValue || x.assessedTotal);
  rows.sort((a, z) => z.year - a.year);
  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i + 1];
    rows[i].yoyMarketPct = prev?.marketValue && rows[i].marketValue
      ? Math.round(((rows[i].marketValue - prev.marketValue) / prev.marketValue) * 1000) / 10 : null;
  }
  return { provenance: "live", bbl, rows, note: "DOF Property Valuation & Assessment roll. Estimated tax = taxable × statutory class rate." };
}

// ---------------------------------------------------------------- lien / zap / transit / cliffs
export async function liveLienSale(bbl) {
  const r = await lienSaleByLot(bbl);
  if (!r.live) return null;
  return {
    provenance: "live",
    onList: (r.rows ?? []).length > 0,
    records: (r.rows ?? []).map((x) => ({ month: day(x.month), cycle: x.cycle, waterOnly: /yes/i.test(x.water_debt_only ?? "") }))
  };
}

export async function liveZap(bbl) {
  const r = await zapByLot(bbl);
  if (!r.live) return null;
  return { provenance: "live", rows: r.rows ?? [] };
}

let stationCache = null;
export async function liveTransit(lat, lng) {
  if (!stationCache) {
    const st = await subwayStations();
    if (!st.live) return null;
    stationCache = st.rows;
  }
  const withDist = stationCache.map((s) => {
    const dLat = (s.lat - lat) * 364000, dLng = (s.lng - lng) * 288200;
    return { ...s, distanceFt: Math.round(Math.hypot(dLat, dLng)) };
  }).sort((a, z) => a.distanceFt - z.distanceFt);
  return {
    provenance: "live",
    nearest: { name: withDist[0].name, lines: withDist[0].lines, distanceFt: withDist[0].distanceFt },
    within: {
      quarterMile: withDist.filter((s) => s.distanceFt <= 1320).length,
      halfMile: withDist.filter((s) => s.distanceFt <= 2640).length
    },
    stations: withDist.slice(0, 6).map((s) => ({
      name: s.name, routes: s.lines.split(",").filter(Boolean),
      walk_min: Math.max(1, Math.round(s.distanceFt / 280)),
      dist_mi: Math.round((s.distanceFt / 5280) * 100) / 100
    }))
  };
}

// LL97/LL33 from the real LL84 disclosure when the building reports; honest
// unknown otherwise (audit #7, #36). J-51 is not derivable from open data
// with certainty — always returned as unknown with the official lookup.
export async function liveCliffs(bbl, b) {
  const out = { provenance: "live", bbl, j51: null, ll97: null, ll33: null, j51Note: "J-51 status requires the DOF benefit lookup for this BBL — not published as a clean open dataset. Verify at the official portal.", unknowns: [] };
  const ll = await ll84ByBbl(bbl);
  if (ll && ll.live && ll.rows.length) {
    const r = ll.rows[0];
    const pick = (...keys) => { for (const k of keys) { const v = num(r[k]); if (v != null) return v; } return null; };
    const ghg = pick("total_ghg_emissions_metric", "total_ghg_emissions_metric_tons_co2e", "total_location_based_ghg");
    const grade = r.energy_star_score ? null : null;
    const score = pick("energy_star_score");
    // LL84's own benchmarked floor area, not PLUTO's. The emissions figure is
    // disclosed against this area, so the cap has to be computed against the
    // same one — see ll97FromDisclosure. On the Empire State Building PLUTO says
    // 2,812,739 sf and LL84 says 2,852,257, which moved the quoted 2030 penalty
    // by $47,839.
    const gfa = pick("property_gfa_calculated", "property_gfa_self_reported", "property_gfa_calculated_buildings", "dof_gross_floor_area");
    if (ghg != null && (gfa || b?.bldgArea)) {
      // One implementation of the LL97 arithmetic, shared with the regulatory
      // router. This used to compute it inline from rounded inputs, which is
      // both a second copy that can drift and a rounding error the $268/ton
      // multiplier magnifies into the figure an owner is quoted.
      const { ll97FromDisclosure } = await import("./cliffs-contract.js");
      out.ll97 = ll97FromDisclosure({
        reportedGhg: ghg,
        gfa,
        bldgArea: b?.bldgArea,
        propertyType: r.largest_property_use_type || r.primary_property_type_self || r.primary_property_type_self_selected || r.primary_property_type || null,
        reportYear: r.report_year ?? r.calendar_year ?? null,
        note: "GHG from the building's LL84 disclosure; 2030 cap and penalty are labeled estimates — confirm with an energy audit."
      });
    } else out.unknowns.push("LL97: no usable emissions figure in the LL84 disclosure for this building.");
    if (score != null) {
      out.ll33 = { grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D", score: Math.round(score), source: "LL84 ENERGY STAR score" };
    } else out.unknowns.push("LL33: no ENERGY STAR score reported.");
  } else {
    out.unknowns.push("LL84: no benchmarking disclosure found for this BBL (buildings under 25,000 sf are not covered).");
  }
  return out;
}

// ---------------------------------------------------------------- area / market
export async function liveAreaBuildings(zips, { page = 0, pageSize = 200, sort = "score", cls = "" } = {}) {
  const order = {
    score: "bldgarea DESC", propensity: "yearbuilt ASC", unusedFar: "lotarea DESC",
    lotArea: "lotarea DESC", assessed: "assesstot DESC", yearBuilt: "yearbuilt ASC", unitsRes: "unitsres DESC"
  }[sort] ?? "bldgarea DESC";
  const r = await plutoByZips(zips, { limit: pageSize, offset: page * pageSize, order });
  if (!r.live) return null;
  const count = await plutoCountByZips(zips);
  let buildings = r.rows.map(plutoRowToBuilding).filter((b) => b.lat && b.lng);
  for (const b of buildings) {
    const prop = computePropensity(b);
    b.propensity = prop.score;
    b.propensityWhy = prop.components.slice(0, 2).map((c) => c.label).join(" · ");
    b.score = devScoreFromReal(b);
  }
  if (cls) buildings = buildings.filter((b) => (b.bldgClass ?? "")[0] === cls[0]);
  if (sort === "score") buildings.sort((a, z) => z.score - a.score);
  if (sort === "propensity") buildings.sort((a, z) => (z.propensity ?? 0) - (a.propensity ?? 0));
  if (sort === "unusedFar") buildings.sort((a, z) => (z.unusedFarSf ?? 0) - (a.unusedFarSf ?? 0));
  return { provenance: "live", total: count.count || buildings.length, page, buildings };
}

// The nearest tax lots to a point, as the original ranks them.
//
// BOX. +/- 0.0022 degrees on both axes. Measured against the original on ten
// probes by taking the 24 nearest PLUTO lots inside a centred degree box and
// comparing BBL sets: 0.0020 reproduced 4/10, 0.0021 and 0.0022 reproduced
// 8/10 (Midtown, Staten Island, FiDi, East Village, Crown Heights, Astoria,
// Bay Ridge, Jamaica), 0.0023 5/10, 0.0024 4/10. A latitude-corrected 190 m
// box — which is what the original's own coverage line describes — reproduced
// 7/10. 0.0022 is the measured best.
//
// The two probes it does not reproduce are Bed-Stuy (40.6870,-73.9440), where
// the original omits six lots inside the box that are nearer than ones it
// keeps (563 GATES AVENUE at 83 ft, 573 GATES AVE at 99 ft, 555 GATES AVENUE,
// 553 GATES AVENUE and two vacant Gates/Tompkins parcels), and the South Bronx
// (40.8296,-73.9262), where it omits two. I do not know the exact cause of
// this yet: those six share no bldgclass, land use, unit count, year, lot or
// building area, owner or PLUTO column that separates them from the eighteen
// the original keeps, and no box, radius, nearest-N prefix or row cap I tested
// reproduces both those probes and the eight that already match.
//
// POOL. Exhausted, not capped. See plutoBboxAll.
//
// DISTANCE. util.js's haversineFt, whose radius is solved from the original's
// own published distances (see the note there). It reproduces 216/216 of them.
// The equirectangular 364000/288200 approximation this used before was wrong by
// up to 25 ft — Midtown BBL 1012580001: original 153 ft, this function 160 —
// and the same haversine was already ranking peers elsewhere in this file.
//
// TIES. The original sorts on the rounded foot, not the raw distance: at Bay
// Ridge BBL 5000160103 (raw 364.2384) is listed before 5000160041 (raw
// 364.1046), both published as 364. So ties fall out of source row order, and
// Array#sort has been stable since ES2019 — the tie-break lives in the
// adapter's :id ordering, not here.
export const NEARBY_BOX_DEG = 0.0022;

// PROJECTION. Built here rather than in the route, because it needs the raw
// PLUTO row: the original omits a key entirely when the column is absent and
// publishes it when the column holds 0.
//
//   original East Village lot 1005310016, whose PLUTO row carries nothing but
//   bbl/latitude/longitude:
//     {"bbl":"1005310016","address":"—","distanceFt":154,"lat":…,"lng":…,"bearing":161}
//   original Bed-Stuy lot 3018150007, whose unitstotal IS 0:
//     {…,"bldgClass":"M1","units":0,"yearBuilt":1931,…,"owner":"ST PAUL CHURCH OF CHRIST DISCIPLES",…}
//
// plutoRowToBuilding cannot express that difference — it coerces a missing
// column to "" or 0 — so absent stays absent here and the key order is the
// original's.
const nearbyNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
function nearbyLot(row, lat, lng) {
  const bLat = nearbyNum(row.latitude), bLng = nearbyNum(row.longitude);
  const hasUnits = row.unitstotal != null || row.unitsres != null;
  return {
    bbl: String(row.bbl ?? "").replace(/\..*$/, ""),
    // "—" for a lot PLUTO carries no address for. Measured on lot 1005310016.
    address: row.address == null || row.address === "" ? "—" : row.address,
    bldgClass: row.bldgclass == null ? undefined : row.bldgclass,
    units: hasUnits ? (nearbyNum(row.unitstotal) || nearbyNum(row.unitsres) || 0) : undefined,
    yearBuilt: row.yearbuilt == null ? undefined : nearbyNum(row.yearbuilt),
    distanceFt: haversineFt(lat, lng, bLat, bLng),
    lat: bLat, lng: bLng,
    owner: row.ownername == null ? undefined : row.ownername,
    bearing: Math.round((Math.atan2((bLng - lng) * Math.cos(lat * Math.PI / 180), bLat - lat) * 180 / Math.PI + 360) % 360)
  };
}

export async function liveNearby(lat, lng, limit = 24) {
  const d = NEARBY_BOX_DEG;
  const r = await plutoBboxAll(lat - d, lng - d, lat + d, lng + d, { maxRows: 5000 });
  if (!r.live) return null;
  // A truncated pool cannot be ranked: the "nearest" lots would be the nearest
  // of an arbitrary page, not the nearest that exist.
  if (r.complete !== true) return null;
  return r.rows
    .filter((row) => nearbyNum(row.latitude) && nearbyNum(row.longitude))
    .map((row) => nearbyLot(row, lat, lng))
    .sort((a, z) => a.distanceFt - z.distanceFt)
    .slice(0, limit);
}

export async function liveMarket(zips) {
  const [salesR, pipeR] = await Promise.all([rollingSalesByZips(zips, { limit: 600 }), dobNowByZips(zips)]);
  if (!salesR.live) return null;
  const sales = (salesR.rows ?? []).map((s) => ({
    saleDate: day(s.sale_date), salePrice: num(s.sale_price), address: s.address,
    bldgClass: s.building_class_at_present, category: s.building_class_category,
    grossSf: parseSalesNum(s.gross_square_feet), landSf: parseSalesNum(s.land_square_feet),
    unitsRes: num(s.residential_units), zip: s.zip_code,
    ppsf: parseSalesNum(s.gross_square_feet) && num(s.sale_price) ? Math.round(num(s.sale_price) / parseSalesNum(s.gross_square_feet)) : null,
    bbl: s.borough && s.block && s.lot ? `${s.borough}${String(s.block).padStart(5, "0")}${String(s.lot).padStart(4, "0")}` : null
  })).filter((s) => s.salePrice > 10000);
  // A filing is classified by what it actually is: a new building, a
  // foundation job on an existing site, or a full demolition. proposedUnits
  // and the BBL come straight out of the record — they were hardcoded to null,
  // which made the pipeline's unit total sum to zero and left every site
  // without a lot to click through to.
  const pipeline = (pipeR.rows ?? []).map((x) => {
    const isNewBuilding = /new building/i.test(x.job_type ?? "");
    const isDemolition = String(x.full_demolition_work_type_ ?? "").toUpperCase() === "YES";
    const isFoundation = String(x.foundation_work_type_ ?? "").toUpperCase() === "YES";
    const kind = isNewBuilding ? "New Building" : isDemolition ? "Demolition" : isFoundation ? "Foundation" : (x.job_type ?? "—");
    const bbl = x.bbl
      ? String(x.bbl).split(".")[0]
      : (x.borough && x.block && x.lot
        ? `${x.borough}${String(x.block).padStart(5, "0")}${String(x.lot).padStart(4, "0")}`
        : null);
    return {
      filingDate: day(x.filing_date),
      address: [x.house_no, x.street_name].filter(Boolean).join(" "),
      kind,
      status: x.filing_status ?? "—",
      applicant: x.applicant_business_name
        || [x.applicant_first_name, x.applicant_last_name].filter(Boolean).join(" ")
        || "—",
      owner: [x.owner_first_name, x.owner_last_name].filter(Boolean).join(" ") || x.owner_s_business_name || "—",
      proposedUnits: Number(x.proposed_dwelling_units) || 0,
      proposedSf: Number(x.total_construction_floor_area) || 0,
      bin: x.bin ?? null,
      bbl
    };
  });
  return { provenance: "live", sales, pipeline };
}

// Real propensity backtest: score every live lot in the area, then measure how
// the actually-recorded 12-month sales concentrate in the top propensity band.
export async function livePropensityBacktest(zips) {
  const [area, salesR] = await Promise.all([
    plutoByZips(zips, { limit: 800, order: "bldgarea DESC" }),
    rollingSalesByZips(zips, { limit: 500 })
  ]);
  if (!area.live || !salesR.live) return null;
  const lots = area.rows.map(plutoRowToBuilding);
  const soldBbls = new Set((salesR.rows ?? []).filter((s) => num(s.sale_price) > 10000)
    .map((s) => `${s.borough}${String(s.block).padStart(5, "0")}${String(s.lot).padStart(4, "0")}`));
  let scored = lots.map((b) => ({ bbl: b.bbl, p: computePropensity(b).score, sold: soldBbls.has(b.bbl) }));
  scored = scored.filter((x) => x.p != null);
  if (!scored.length) return null;
  scored.sort((a, z) => z.p - a.p);
  const top = scored.slice(0, Math.max(10, Math.floor(scored.length * 0.2)));
  const baseRate = scored.filter((x) => x.sold).length / scored.length;
  const topRate = top.filter((x) => x.sold).length / top.length;
  return {
    provenance: "live",
    sample: scored.length, sold: scored.filter((x) => x.sold).length,
    baseRatePct: Math.round(baseRate * 1000) / 10,
    topBandRatePct: Math.round(topRate * 1000) / 10,
    lift: baseRate > 0 ? Math.round((topRate / baseRate) * 100) / 100 : null,
    note: "Backtest on recorded transactions: propensity scored from live parcel attributes; 'sold' = an actual arm's-length recorded sale in the trailing 12 months."
  };
}

export async function liveMaturityWall(bbls) {
  const loans = [];
  const satisfied = [];
  let liveSources = 0;
  let checked = 0;
  for (const bbl of bbls.slice(0, 25)) {
    checked += 1;
    const [acris, plu] = await Promise.all([acrisByLot(bbl), plutoByBbl(bbl)]);
    if (!acris.live) continue;
    liveSources += 1;
    const b = plu.rows?.[0] ? plutoRowToBuilding(plu.rows[0]) : null;
    // Pass the WHOLE financing set, satisfactions included.
    //
    // This used to filter to `kind === "mortgage"` first. estimateDebtMaturity
    // exists partly to notice that a later SATISFACTION / RELEASE / DISCHARGE
    // is on record — that is what its SAT_RE branch is for — and that filter
    // removed every one of those documents before the estimator could see them.
    // The check could therefore never fire, and a mortgage that ACRIS shows as
    // discharged years ago was published on the maturity wall as outstanding
    // debt with a "past maturity" flag: an invented fact about a real address.
    //
    // The estimator's own MTGE_RE / SAT_RE pair does the selection it was
    // written to do, which also restores CONSOLIDATION / EXTENSION /
    // MODIFICATION agreements (kind "agreement") to consideration — a CEMA
    // restates the debt and resets the clock, so dropping it dated the loan to
    // a superseded recording.
    const financing = (acris.mortgages ?? [])
      .filter((m) => ["mortgage", "agreement", "satisfaction"].includes(m.kind));
    const record = {
      loans: financing.map((m) => ({
        date: day(m.document_date || m.recorded_datetime), amount: num(m.document_amt) || 0,
        docType: m.doc_type,
        lender: (acris.parties?.[m.document_id] ?? []).filter((p) => p.party_type === "2").map((p) => p.name).join("; ") || "—"
      }))
    };
    const est = estimateDebtMaturity(record, new Date().getFullYear());
    if (!est?.estMaturityYear) continue;
    if (est.satisfied) {
      // Recorded as repaid. It is not on the wall, and it is not silently
      // vanished either — the caller is told which parcels were dropped and
      // why, so an empty wall is distinguishable from a suppressed one.
      satisfied.push({
        bbl, address: b?.address ?? `BBL ${bbl}`,
        originated: est.date, satisfactionDate: est.satisfactionDate, docType: est.satisfactionDocType
      });
      continue;
    }
    loans.push({
      bbl, address: b?.address ?? `BBL ${bbl}`, owner: b?.owner ?? "—",
      lender: est.lender, amount: est.amount, originated: est.date,
      estMaturityYear: est.estMaturityYear, status: est.status
    });
  }
  loans.sort((a, z) => a.estMaturityYear - z.estMaturityYear);
  // liveSources distinguishes "the record shows no qualifying debt" (a real,
  // configured answer) from "no source could be reached" (unconfigured).
  return {
    provenance: "live", configured: liveSources > 0, checked, liveSources, loans,
    ...(satisfied.length ? {
      satisfiedExcluded: {
        count: satisfied.length,
        parcels: satisfied,
        reason: "ACRIS carries a satisfaction, release or discharge recorded after these mortgages, so the loans are repaid on the public record. They are excluded from the maturity wall rather than presented as debt approaching or past maturity."
      }
    } : {})
  };
}

export { acsByZip as liveDemographics, parseBbl };
