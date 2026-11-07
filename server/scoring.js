// Scoring models shared across the platform, recovered from the shipped
// client. Three models live here:
//   1. Opportunity score — the curated-universe conviction model (0–100).
//   2. Seller-propensity — transparent additive model over public-record
//      fields; every component cites the dataset + field it reads.
//   3. Distress / motivated-seller — debt-maturity + violations + hold length.

export const WEIGHTS = { density: 22, catalyst: 20, location: 18, execution: 18, conversion: 12, source: 10 };
export const RISK_MULTIPLIER = { Low: 1, Moderate: 0.75, Elevated: 0.5, High: 0.3 };
export const CONVERSION_MULTIPLIER = { Prime: 1, Strong: 0.8, Possible: 0.55, "N/A": 0.4 };

export const DEEP_LIQUIDITY_NEIGHBORHOODS = [
  "FiDi / Lower Manhattan", "Tribeca / SoHo / NoHo", "Chelsea / Hudson Yards",
  "Flatiron / NoMad", "Garment District / Midtown South", "Midtown East",
  "Upper West Side (below 110)", "Upper East Side (below 96)",
  "Downtown Brooklyn / Fort Greene", "Williamsburg / Greenpoint", "LIC / Hunters Point"
];

const clamp01 = (n) => Math.max(0, Math.min(1, n));

export function computeOpportunityScore(p) {
  const densityRaw =
    (0.6 * (p.maxFar > 0 ? clamp01((p.maxFar - p.far) / p.maxFar) : 0) +
      0.4 * clamp01(p.unbuiltFarSf / 150000)) ||
    (p.adaptiveReuse ? 0.45 : 0.1);
  const catalystRaw = clamp01(p.policyCatalysts.length / 3) * (p.adaptiveReuse ? 1 : 0.85);
  const locationRaw = DEEP_LIQUIDITY_NEIGHBORHOODS.includes(p.neighborhood) ? 0.85 : 0.55;
  const executionRaw = RISK_MULTIPLIER[p.risk] ?? 0.5;
  const conversionRaw = CONVERSION_MULTIPLIER[p.conversionFit] ?? 0.4;
  const sourceRaw = clamp01(p.signals.length / 4);
  const total =
    densityRaw * WEIGHTS.density + catalystRaw * WEIGHTS.catalyst +
    locationRaw * WEIGHTS.location + executionRaw * WEIGHTS.execution +
    conversionRaw * WEIGHTS.conversion + sourceRaw * WEIGHTS.source;
  return Math.max(0, Math.min(100, Math.round(total)));
}

const GOV_RE = /\bCITY OF\b|\bNYC\b|NEW YORK CITY|STATE OF NEW ?YORK|\bNY STATE\b|\bNYS\b|UNITED STATES|\bFEDERAL\b|DEPARTMENT OF|DEPT OF|\bDEPT\b|\bAUTHORITY\b|\bAUTH\b|DORMITORY|METROPOLITAN TRANS|\bMTA\b|\bTRANSIT\b|PORT AUTH|HOUSING AUTH|\bNYCHA\b|TRIBOROUGH|\bRAILROAD\b|\bAMTRAK\b|CON ?ED|CONSOLIDATED EDISON|NATIONAL GRID|BOARD OF ED|PUBLIC LIBRARY|POST OFFICE|\bSANITATION\b|ECONOMIC DEVELOPMENT|\bEDC\b|PUBLIC SCHOOL/;
const INSTITUTIONAL_RE = /LLC|L\.L|\bINC\b|CORP|\bLP\b|L\.P|REIT|ASSOC|PARTNER|REALTY|MANAGEMENT|MGMT|HOLDING|TRUST|FUND|PROPERT|GROUP|CHURCH|HOSPITAL/;

// Seller-propensity. Input is a PLUTO-shaped record:
// { yearBuilt, builtFar, maxFar, lotArea, owner, unitsRes, assessLand, assessTotal, permitCount }
export function computePropensity(b, nowYear = 2026) {
  const owner = (b.owner ?? "").toUpperCase();
  if (owner && GOV_RE.test(owner)) {
    return { score: 0, band: "Low", reasons: [], components: [], excluded: "Government / transit / utility / authority owner — excluded (does not sell to private buyers)." };
  }
  const comps = [];
  const age = b.yearBuilt && b.yearBuilt > 1800 ? nowYear - b.yearBuilt : null;
  if (age != null && age >= 90) comps.push({ label: "Aging structure", points: 14, detail: `Built ${b.yearBuilt} — ${age} years old; systems/use often functionally dated, which strengthens the case for a sale or gut repositioning.`, source: "Public record · yearbuilt" });
  else if (age != null && age >= 60) comps.push({ label: "Older structure", points: 7, detail: `Built ${b.yearBuilt} (${age} yrs).`, source: "Public record · yearbuilt" });

  const unusedFar = b.maxFar && b.maxFar > 0 ? Math.max(0, b.maxFar - (b.builtFar || 0)) : 0;
  const unusedSf = b.lotArea ? Math.round(unusedFar * b.lotArea) : 0;
  const envShare = b.maxFar && b.maxFar > 0 ? unusedFar / b.maxFar : 0;
  if (unusedSf > 50000 && envShare > 0.5) comps.push({ label: "Major unused development rights", points: 24, detail: `${unusedSf.toLocaleString()} sf of unused FAR — built ${(b.builtFar ?? 0).toFixed(2)} of ${(b.maxFar ?? 0).toFixed(2)} max FAR on a ${(b.lotArea ?? 0).toLocaleString()} sf lot (${Math.round(envShare * 100)}% of the envelope unbuilt). Owners sitting on this much air rights either build or sell.`, source: "Public record · builtfar / residfar / commfar / lotarea" });
  else if (unusedSf > 15000 && envShare > 0.4) comps.push({ label: "Meaningful unused FAR", points: 13, detail: `${unusedSf.toLocaleString()} sf of unused FAR (${Math.round(envShare * 100)}% of the envelope unbuilt) — monetizable development rights.`, source: "Public record · builtfar / lotarea" });

  if (b.assessLand && b.assessTotal && b.assessTotal > 0) {
    const share = b.assessLand / b.assessTotal;
    if (share >= 0.75) comps.push({ label: "Land-heavy assessment", points: 12, detail: `${Math.round(share * 100)}% of assessed value is land ($${Math.round(b.assessLand).toLocaleString()} of $${Math.round(b.assessTotal).toLocaleString()}) — the City's assessor puts the value in the dirt, the classic teardown/redevelopment profile.`, source: "Public record · assessland / assesstot" });
  }

  const institutional = INSTITUTIONAL_RE.test(owner);
  if (owner && !institutional) comps.push({ label: "Individual / non-institutional owner", points: 11, detail: `Owner of record "${b.owner}" reads as an individual, not an institution — estate, generational-transfer, and tax-basis-reset motivations cluster here.`, source: "Public record · ownername" });
  if ((b.permitCount || 0) === 0 && (age == null || age > 40)) comps.push({ label: "No reinvestment", points: 6, detail: "No permits on record for an older building — an owner not putting capital in is more open to an exit.", source: "Public record · permits by lot" });
  if ((b.unitsRes || 0) >= 4 && (b.unitsRes || 0) <= 30 && !institutional) comps.push({ label: "Small multifamily, individual hands", points: 6, detail: `${b.unitsRes} residential units under individual ownership — the operationally-tiring size that turns over.`, source: "Public record · unitsres / ownername" });

  const score = Math.min(100, comps.reduce((n, c) => n + c.points, 0));
  const band = score >= 55 ? "High" : score >= 35 ? "Elevated" : score >= 18 ? "Watch" : "Low";
  return { score, band, reasons: comps.map((c) => c.detail), components: comps };
}

const MTGE_RE = /MORTGAGE|MTGE|AGREEMENT|CONSOLIDAT|GAP|SUPPLEMENT/i;
const SAT_RE = /SATISF|RELEASE|DISCHARGE/i;

function yearOf(d) {
  if (!d) return null;
  const y = parseInt(String(d).slice(0, 4), 10);
  return Number.isFinite(y) && y > 1900 ? y : null;
}

export function estimateDebtMaturity(record, nowYear = 2026) {
  const loans = Array.isArray(record?.loans) ? record.loans : [];
  if (!loans.length) return null;
  const isSat = (m) => SAT_RE.test(String(m.docType || ""));
  // The fallback used to be `?? loans[0]`, i.e. whatever document happened to
  // be first. Callers now pass the whole financing set — including the
  // satisfactions this function was written to detect — so an unqualified
  // fallback could name a SATISFACTION OF MORTGAGE as the outstanding loan and
  // print its date and amount under "Originated" and "Balance". A discharge is
  // by definition not outstanding debt, so it can never be the primary loan;
  // the fallback keeps its purpose (take the newest financing document when
  // none carries a positive amount) with that one exclusion.
  const primary =
    loans.filter((m) => MTGE_RE.test(String(m.docType || "")) && !isSat(m) && (m.amount ?? 0) > 0)[0]
    ?? loans.filter((m) => !isSat(m))[0];
  if (!primary) return null;
  const y = yearOf(primary.date);
  if (!y) return null;
  const term = 10;
  const maturity = y + term;
  const satisfactions = loans.filter((m) => isSat(m) && (yearOf(m.date) ?? 0) > y)
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  const laterSat = satisfactions.length > 0;
  let status = "seasoned";
  if (maturity <= nowYear) status = "past";
  else if (maturity - nowYear <= 2) status = "approaching";
  const note = laterSat
    ? "A later satisfaction/release is on record — this loan may already be repaid; verify the current cap stack in the recorded documents."
    : `Assumes a ~${term}-yr term from the ${y} recording; confirm the actual maturity in the mortgage document.`;
  return {
    amount: primary.amount ?? 0, date: primary.date, lender: primary.lender || "—",
    estTermYears: term, estMaturityYear: maturity, status, note,
    // Machine-readable satisfaction result. `note` alone put this in prose that
    // no caller could act on, so every caller presented a discharged loan as
    // live refinance pressure. Callers that rank or score debt must read
    // `satisfied`; `satisfactionsSeen` distinguishes "no discharge on record"
    // from "no discharge documents were supplied to look at".
    satisfied: laterSat,
    satisfactionDate: satisfactions[0]?.date ?? null,
    satisfactionDocType: satisfactions[0]?.docType ?? null,
    satisfactionsSeen: loans.filter(isSat).length,
    documentsConsidered: loans.length
  };
}

export function computeDistressFromRecord(record, nowYear = 2026) {
  const reasons = [];
  const debt = estimateDebtMaturity(record, nowYear);
  let score = 0;
  // A discharged loan is not refinance pressure. The "past maturity" reason
  // text says in so many words "with no recorded refinance", so scoring it
  // while a satisfaction sits in the same record contradicts the evidence the
  // estimator just read. Scored only when the record actually contains no
  // later discharge.
  if (debt && !debt.satisfied) {
    if (debt.status === "past") { score += 30; reasons.push({ label: "Debt past estimated maturity", weight: 30, detail: `~$${Math.round(debt.amount).toLocaleString()} loan from ${debt.lender} recorded ${String(debt.date).slice(0, 4)}; on a ~${debt.estTermYears}-yr term it would mature around ${debt.estMaturityYear}. A loan past maturity with no recorded refinance is real refinance pressure.` }); }
    else if (debt.status === "approaching") { score += 15; reasons.push({ label: "Debt approaching maturity", weight: 15, detail: `~$${Math.round(debt.amount).toLocaleString()} loan estimated to mature ~${debt.estMaturityYear}. Owners often transact ahead of a refinance in a higher-rate market.` }); }
  }
  const hpd = record?.signals?.hpdViolations ?? 0;
  if (hpd > 50) { score += 20; reasons.push({ label: "Heavy housing-maintenance violations", weight: 20, detail: `${hpd} open/known housing-maintenance violations — classic operational distress / deferred maintenance.` }); }
  else if (hpd > 20) { score += 10; reasons.push({ label: "Elevated housing-maintenance violations", weight: 10, detail: `${hpd} housing-maintenance violations indicate management strain.` }); }
  const dob = record?.signals?.dobViolations ?? 0;
  if (dob > 25) { score += 20; reasons.push({ label: "Heavy building violations", weight: 20, detail: `${dob} building violations — unresolved building issues and mounting penalties.` }); }
  else if (dob > 10) { score += 10; reasons.push({ label: "Elevated building violations", weight: 10, detail: `${dob} building violations on record.` }); }
  const hold = record?.metrics?.holdYears ?? null;
  if (hold != null && hold >= 20) { score += 18; reasons.push({ label: "Very long hold", weight: 18, detail: `Held ~${hold} years — long holds skew toward estate, generational-transfer, and tax-basis-reset motivations.` }); }
  else if (hold != null && hold >= 15) { score += 12; reasons.push({ label: "Long hold", weight: 12, detail: `Held ~${hold} years; seasoned ownership is more open to an unsolicited approach.` }); }
  score = Math.min(100, score);
  const band = score >= 60 ? "High" : score >= 40 ? "Elevated" : score >= 20 ? "Watch" : "Low";
  const summary = reasons.length === 0
    ? "No strong distress markers in the public record — a relationship/timing play more than a pressure play."
    : `${band} motivated-seller profile (${score}/100): ${reasons.map((r) => r.label.toLowerCase()).join(", ")}. Stacked public-record pressure usually precedes a lis pendens filing.`;
  return { debt, distressScore: score, band, reasons, summary };
}
