// The dossier's regulatory contract, in one place.
//
// The immutable frontend renders these fields directly and calls
// .toLocaleString() on every LL97 figure, so a missing or non-numeric value is
// a crash, not a blank. Both /api/cliffs implementations — the bundle contract
// router and the regulatory router behind it — normalize through here so a
// fallback response can never carry a shape the UI cannot render.
//
// Required by the UI:
//   j51  → exYears, initYear, endYear, status
//   ll97 → type, ghg, capTons, status, penalty2030, overTons, reportYear
// A section is null only when the record genuinely does not exist; the UI
// hides the row in that case, which is correct and never throws.

// A missing value takes the caller's fallback (which may be a derived figure);
// only a present-but-parseable value overrides it. Number("") is 0, so
// blank/null/undefined must be rejected before parsing.
export const safeNum = (v, fallback = 0) => {
  if (v === null || v === undefined || String(v).trim() === "") return fallback;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : fallback;
};

export const J51_DEFAULT_TERM_YEARS = 14; // standard J-51 alteration exemption term
export const LL97_PENALTY_PER_TON = 268;  // $/tCO2e statutory overage penalty
// 2030 emissions-intensity limit, BY ESPM PROPERTY TYPE.
//
// This was a single 0.00453 for every building, and that is only right for the
// office/default group. Solved 2026-08-19 against https://nycremarketintel.com
// by dividing the capTons it publishes by the gfa it publishes on 232 probes
// across 78 property types, intersecting the rounding intervals per type:
//   0.00110  warehouse / industrial      e.g. Manufacturing/Industrial Plant
//            n=3 -> [0.001100, 0.001100]
//   0.00344  education                   K-12 School n=3 -> [0.003440, 0.003440]
//   0.00400  retail / mall               Strip Mall n=4 -> [0.004000, 0.004000]
//   0.00407  residential                 Multifamily n=4 -> [0.004070, 0.004070]
//   0.00453  DEFAULT (office et al.)     Office n=4 -> [0.004530, 0.004530]
//   0.00526  hotel                       Hotel n=4 -> [0.005260, 0.005260]
//   0.01083  hospital / health           Fitness Center n=2 -> [0.010829, 0.010833]
//                                        Other - Specialty Hospital -> [0.010829, 0.010831]
// The single-constant version was wrong on every non-office lot: 3009810111
// (K-12 School) came out at cap 614 where the original says 466, and
// 2028450001 (Multifamily) at 222 where the original says 200.
export const LL97_2030_INTENSITY = 0.00453;

// Every property type whose measured limit is NOT the 0.00453 default. A type
// absent from this map takes the default; the rare types that no probe could
// reach (Aquarium, Bar/Nightclub, Convenience Store without Gas Station,
// Drinking Water Treatment & Distribution, Lifestyle Center, Movie Theater,
// Not Available, Other - Entertainment/Public Assembly, Other - Stadium,
// Repair Services, Restaurant, Social/Meeting Hall) are therefore on the
// default and remain UNMEASURED.
export const LL97_2030_INTENSITY_BY_TYPE = {
  // warehouse / industrial
  "Distribution Center": 0.00110,
  "Manufacturing/Industrial Plant": 0.00110,
  "Non-Refrigerated Warehouse": 0.00110,
  "Refrigerated Warehouse": 0.00110,
  "Self-Storage Facility": 0.00110,
  // education
  "Adult Education": 0.00344,
  "College/University": 0.00344,
  "K-12 School": 0.00344,
  "Other - Education": 0.00344,
  "Pre-school/Daycare": 0.00344,
  "Vocational School": 0.00344,
  // retail / mall
  "Enclosed Mall": 0.00400,
  "Food Sales": 0.00400,
  "Other - Mall": 0.00400,
  "Retail Store": 0.00400,
  "Strip Mall": 0.00400,
  "Supermarket/Grocery Store": 0.00400,
  // residential
  "Multifamily Housing": 0.00407,
  "Other - Lodging/Residential": 0.00407,
  "Residential Care Facility": 0.00407,
  // hotel
  "Hotel": 0.00526,
  // hospital / health
  "Fitness Center/Health Club/Gym": 0.01083,
  "Hospital (General Medical & Surgical)": 0.01083,
  "Other - Specialty Hospital": 0.01083,
  "Personal Services (Health/Beauty, Dry Cleaning, etc.)": 0.01083
};

export const ll97IntensityForType = (propertyType) =>
  LL97_2030_INTENSITY_BY_TYPE[String(propertyType ?? "").trim()] ?? LL97_2030_INTENSITY;

export function safeJ51(benefit, now = new Date().getUTCFullYear()) {
  if (!benefit?.live || !benefit.j51?.active) return null;
  const startYear = safeNum(String(benefit.j51.startDate ?? "").slice(-4), 0);
  const initYear = safeNum(benefit.j51.periodStart, 0) || startYear || safeNum(benefit.taxYear, now);

  // When DOF publishes the benefit period's end, that is a recorded fact. When
  // it does not, this substitutes the standard 14-year alteration term — and
  // that is an ESTIMATE, from which endYear, exYears and status are all
  // derived. It was returned unlabelled, so an inferred expiry read exactly
  // like a filed one, and "expiring" is a conclusion an owner acts on. Every
  // derived field now carries its basis, the same way the maturity wall does.
  const publishedEnd = safeNum(benefit.j51.periodEnd, 0);
  const endYear = publishedEnd || initYear + J51_DEFAULT_TERM_YEARS;
  const exYears = Math.max(1, endYear - initYear);
  const status = endYear < now ? "expired" : endYear <= now + 2 ? "expiring" : "active";
  const inferred = !publishedEnd;
  return {
    exYears, initYear, endYear, status,
    valueType: inferred ? "estimated" : "published fact",
    endYearEstimated: inferred,
    statusEstimated: inferred,
    basis: inferred
      ? `DOF confirms an active J-51 but publishes no benefit-period end for this lot. endYear, exYears and status are derived from the standard ${J51_DEFAULT_TERM_YEARS}-year alteration term applied to ${initYear} — verify against the filed benefit schedule before relying on the expiry.`
      : "Benefit period start and end as published in the NYC DOF benefit record."
  };
}

export function safeLl97(raw) {
  if (!raw) return null;
  const ghg = Math.max(0, Math.round(safeNum(raw.ghg)));
  const capTons = Math.max(0, Math.round(safeNum(raw.capTons)));
  // Derive from the UNROUNDED figures, round once at the end.
  //
  // Rounding ghg and capTons first and subtracting the rounded pair throws away
  // up to a ton before the $268/ton multiplier touches it, and the error lands
  // on the number an owner is quoted. On the Empire State Building the exact
  // arithmetic is
  //   cap  = 2,852,257 sf x 0.00453      = 12,920.72421
  //   over = 16,678.22 - 12,920.72421    =  3,757.49579
  //   pen  = 3,757.49579 x 268           = $1,007,008.87  -> $1,007,009
  // which is the original's figure to the dollar. Rounding first gave
  // $1,006,876. Callers pass exact values through overTonsExact when they have
  // them; the rounded fallback stays for callers that only have integers.
  const overExact = raw.overTonsExact;
  const haveExact = Number.isFinite(overExact);
  const overTons = Math.max(0, Math.round(safeNum(raw.overTons, haveExact ? overExact : Math.max(0, ghg - capTons))));
  const penalty2030 = Math.max(0, Math.round(safeNum(
    raw.penalty2030,
    (haveExact ? Math.max(0, overExact) : overTons) * LL97_PENALTY_PER_TON
  )));
  return {
    type: raw.type || "Covered building",
    ghg, capTons,
    // The LL84-reported gross floor area the cap is computed against. It was
    // absent, so the response asserted a cap without showing its denominator —
    // and the denominator is exactly where this differed from the original.
    gfa: Number.isFinite(safeNum(raw.gfa, NaN)) ? Math.round(safeNum(raw.gfa)) : null,
    status: overTons > 0 ? "exposed" : "compliant",
    penalty2030, overTons,
    // String, as the original returns it and as LL84 publishes it.
    reportYear: raw.reportYear == null || String(raw.reportYear).trim() === "" ? null : String(raw.reportYear),
    note: raw.note
  };
}

// Build the UI-shaped ll97 block from a published LL84 disclosure row plus the
// building's floor area. Returns null when the disclosure carries no usable
// emissions figure — the UI then hides the row rather than showing zeros.
export function ll97FromDisclosure({ reportedGhg, bldgArea, gfa, propertyType, reportYear, note }) {
  const ghg = safeNum(reportedGhg, NaN);
  if (!Number.isFinite(ghg)) return null;
  // The floor area LL84 reports for this building, not PLUTO's.
  //
  // The emissions figure above is disclosed against the property's own
  // benchmarked gross floor area, so dividing it by a different area produces an
  // intensity for a building that does not exist. PLUTO says 2,812,739 sf for
  // the Empire State Building and LL84 says 2,852,257 — a 39,518 sf gap that
  // moved the cap by 179 tons and the quoted 2030 penalty by $47,839. Callers
  // pass the disclosure's area as `gfa`; `bldgArea` stays as the fallback for a
  // disclosure that does not report one.
  const area = safeNum(gfa, 0) || safeNum(bldgArea, 0);
  const capExact = area > 0 ? area * ll97IntensityForType(propertyType) : 0;
  return safeLl97({
    type: propertyType || null,
    ghg,
    gfa: area || null,
    capTons: capExact,
    overTonsExact: Math.max(0, ghg - capExact),
    reportYear,
    note: note || "GHG from the building's LL84 disclosure; the 2030 cap and penalty are labeled estimates — confirm with an energy audit."
  });
}
