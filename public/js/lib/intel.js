// The client-side intelligence layer. Everything in here is presentation
// logic ported from the original client: the score breakdown, tier language,
// investment justification, evidence spine, contact strategy, "so what"
// call angle, diligence framework, seller-propensity display and outreach
// drafting all run in the browser from raw parcel fields.

export const WEIGHTS = { density: 22, catalyst: 20, location: 18, execution: 18, conversion: 12, source: 10 };
const RISK_MULT = { Low: 1, Moderate: 0.75, Elevated: 0.5, High: 0.3 };
const CONV_MULT = { Prime: 1, Strong: 0.8, Possible: 0.55, "N/A": 0.4 };
const DEEP = ["FiDi / Lower Manhattan","Tribeca / SoHo / NoHo","Chelsea / Hudson Yards","Flatiron / NoMad","Garment District / Midtown South","Midtown East","Upper West Side (below 110)","Upper East Side (below 96)","Downtown Brooklyn / Fort Greene","Williamsburg / Greenpoint","LIC / Hunters Point"];
const c01 = (n) => Math.max(0, Math.min(1, n));
const fmt = (n) => Math.round(n).toLocaleString();

export const bblDigits = (p) => String(p.bbl).replace(/[^0-9]/g, "");
const GENERIC = ["vicinity", "corridor", "assemblage", "edge", "node", "block", "parcel"];
export const isExactAddress = (p) => !GENERIC.some((w) => p.address.toLowerCase().includes(w));
export const precisionLabel = (p) => (isExactAddress(p) ? "Live-ready" : "Block-level (live)");
export const precisionDetail = (p) =>
  isExactAddress(p)
    ? "Exact-address target. The dossier pulls parcel, permit, ownership, zoning, and sales records automatically against this BBL; distress, environmental, and flood checks are linked for the deal file."
    : "Block-level pull: live sources are queried by borough/block/lot, so block-level sales, ownership, and permit evidence are pulled and shown. Pinning the record to one exact lot tightens the same live pull to a single parcel.";

// --- Score breakdown (largest-remainder allocation across weighted components)
export function scoreBreakdown(p) {
  const densityRaw = (0.6 * (p.maxFar > 0 ? c01((p.maxFar - p.far) / p.maxFar) : 0) + 0.4 * c01(p.unbuiltFarSf / 15e4)) || (p.adaptiveReuse ? 0.45 : 0.1);
  const catalystRaw = c01(p.policyCatalysts.length / 3) * (p.adaptiveReuse ? 1 : 0.85);
  const locationRaw = DEEP.includes(p.neighborhood) ? 0.85 : 0.55;
  const executionRaw = RISK_MULT[p.risk] ?? 0.5;
  const conversionRaw = CONV_MULT[p.conversionFit] ?? 0.4;
  const sourceRaw = c01(p.signals.length / 4);
  const defs = [
    { label: "Density / FAR upside", raw: densityRaw, max: WEIGHTS.density, rationale: p.unbuiltFarSf > 0 ? `~${fmt(p.unbuiltFarSf)} sf unused FAR (${p.far.toFixed(1)} built vs ${p.maxFar.toFixed(1)} max).` : p.adaptiveReuse ? "Limited added FAR; value comes from conversion/repositioning rather than new density." : "Largely built out; minimal density upside in the model." },
    { label: "Policy catalyst", raw: catalystRaw, max: WEIGHTS.catalyst, rationale: p.policyCatalysts.length ? `Catalysts: ${p.policyCatalysts.join(", ")} (eligibility to be confirmed against controlling text).` : "No incentive catalyst attached; must clear on as-of-right economics." },
    { label: "Location / liquidity", raw: locationRaw, max: WEIGHTS.location, rationale: DEEP.includes(p.neighborhood) ? `${p.neighborhood} is a deep, liquid submarket with strong exit optionality.` : `${p.neighborhood} is a developing submarket; liquidity is thinner.` },
    { label: "Execution risk", raw: executionRaw, max: WEIGHTS.execution, rationale: `Risk marked ${p.risk.toLowerCase()}${p.riskFlags.length ? `: ${p.riskFlags.join("; ")}.` : "."}` },
    { label: "Conversion / use fit", raw: conversionRaw, max: WEIGHTS.conversion, rationale: `Conversion fit modeled as ${p.conversionFit}.` },
    { label: "Source confidence", raw: sourceRaw, max: WEIGHTS.source, rationale: `Signal stack: ${p.signals.join(", ") || "none"} (${p.signals.length}/4 public sources modeled).` }
  ];
  const total = Math.min(p.opportunityScore, defs.reduce((n, d) => n + d.max, 0));
  const pool = defs.map((d) => ({ ...d, weight: d.raw * d.max, points: 0 }));
  let remaining = total;
  for (let iter = 0; iter < pool.length + 1 && remaining > 1e-9; iter++) {
    const open = pool.filter((c) => c.points < c.max - 1e-9);
    if (!open.length) break;
    const wsum = open.reduce((n, c) => n + c.weight, 0);
    if (wsum <= 1e-9) {
      const cap = open.reduce((n, c) => n + (c.max - c.points), 0);
      if (cap <= 1e-9) break;
      for (const c of open) c.points += Math.min(c.max - c.points, remaining * ((c.max - c.points) / cap));
      remaining = total - pool.reduce((n, c) => n + c.points, 0);
      continue;
    }
    let given = 0;
    for (const c of open) {
      const share = Math.min(remaining * (c.weight / wsum), c.max - c.points);
      c.points += share; given += share;
    }
    remaining -= given;
  }
  const ints = pool.map((c) => ({ ...c, intPoints: Math.floor(c.points), frac: c.points - Math.floor(c.points) }));
  let leftover = total - ints.reduce((n, c) => n + c.intPoints, 0);
  [...ints].sort((a, b) => b.frac - a.frac).forEach((c) => { if (leftover > 0 && c.intPoints < c.max) { c.intPoints += 1; leftover -= 1; } });
  return {
    total: p.opportunityScore,
    components: ints.map(({ label, intPoints, max, rationale }) => ({ label, points: intPoints, max, rationale })),
    interpretation: `${p.opportunityScore}/100 is a modeled conviction score — a relative ranking of this ${p.category.toLowerCase()} against the pipeline, not a verified valuation, appraisal, or guarantee of return. It weights density upside, policy catalysts, submarket liquidity, execution risk, use fit, and how many public sources corroborate the record. Live sources are reconciled automatically by block/lot; resolving to one exact lot tightens it to pricing-grade confidence.`
  };
}

export function tierOf(score) {
  return score >= 85 ? { tier: "Top-decile conviction", verb: "warrants a proactive, well-resourced approach" }
    : score >= 75 ? { tier: "High conviction", verb: "merits a focused workup and direct owner contact" }
    : score >= 60 ? { tier: "Actionable", verb: "is worth a disciplined first pass to confirm the thesis" }
    : score >= 45 ? { tier: "Watch-list", verb: "is a monitor candidate pending a clearer catalyst" }
    : { tier: "Screening only", verb: "is early — track for a change in basis or zoning" };
}

// --- Investment justification (curated parcel)
export function justification(p) {
  const { tier, verb } = tierOf(p.opportunityScore);
  const envPct = p.maxFar > 0 ? ((p.maxFar - p.far) / p.maxFar) * 100 : 0;
  const drivers = [];
  if (p.unbuiltFarSf > 0) drivers.push(`~${fmt(p.unbuiltFarSf)} sf of unused as-of-right buildable (${p.far.toFixed(1)} built vs ${p.maxFar.toFixed(1)} max FAR — ${Math.round(envPct)}% of the envelope unbuilt).`);
  else if (p.adaptiveReuse) drivers.push("Value is created by conversion/repositioning of an existing envelope rather than new density — the cleaner path where land is effectively built out.");
  if (p.policyCatalysts.length) drivers.push(`Policy tailwinds in play: ${p.policyCatalysts.join(", ")} (eligibility to be confirmed against controlling text).`);
  drivers.push(`${p.neighborhood} — ${p.conversionFit.toLowerCase()} use fit, ${p.risk.toLowerCase()} modeled execution risk.`);
  if (p.signals.length) drivers.push(`Corroborated across ${p.signals.length} public-data signal${p.signals.length === 1 ? "" : "s"}: ${p.signals.join(", ")}.`);
  if (p.estLandPpbsf) drivers.push(`Modeled basis ~$${p.estLandPpbsf}/buildable sf — the figure to test against live land comps in this submarket.`);
  const core = p.unbuiltFarSf > 0
    ? `roughly ${Math.round(envPct)}% of its as-of-right envelope sits unbuilt (~${fmt(p.unbuiltFarSf)} sf), so the lot is meaningfully underdeveloped relative to what the zoning permits`
    : p.adaptiveReuse
      ? "the asset is effectively built out, which shifts the thesis from added density to conversion economics on an existing envelope"
      : "the lot is largely built out, so any upside leans on use repositioning rather than incremental floor area";
  const catalystLine = p.policyCatalysts.length
    ? ` Current policy catalysts (${p.policyCatalysts.join(", ")}) can compress the cost of that move if the parcel qualifies`
    : " It has to clear on as-of-right economics, with no incentive program currently carrying the underwriting";
  const thesis = `This ${p.category.toLowerCase()} in ${p.neighborhood} ${verb}. The core of the case is that ${core}.` + catalystLine +
    `. Use fit is modeled ${p.conversionFit.toLowerCase()} and execution risk ${p.risk.toLowerCase()}, which together set how aggressively to pursue it. ${p.signals.length ? `${p.signals.length} independent public-record signal${p.signals.length === 1 ? "" : "s"} support the read, ` : ""}and the live pull reconciles the parcel by block/lot so the thesis can be pressure-tested against current filings, debt, and sales rather than a static model.`;
  return { tier, headline: `${tier} — ${p.category} in ${p.neighborhood}.`, thesis, drivers,
    caveat: "Modeled conviction, not a valuation. Confirm zoning/overlay, incentive eligibility against controlling text, and resolve the exact lot before committing capital or pricing." };
}

// --- Justification for a live building (PLUTO-shaped)
export function buildingJustification(b) {
  const { tier, verb } = tierOf(b.score);
  const maxFar = b.maxFar ?? 0, built = b.builtFar ?? 0;
  const envSf = b.lotArea && maxFar ? maxFar * b.lotArea : 0;
  const unused = b.unusedFarSf ?? (envSf && b.bldgArea ? Math.max(0, envSf - b.bldgArea) : 0);
  const envPct = envSf > 0 ? (unused / envSf) * 100 : 0;
  const age = b.yearBuilt && b.yearBuilt > 1800 ? new Date().getFullYear() - b.yearBuilt : 0;
  const drivers = [];
  if (unused > 500 && envSf > 0) drivers.push(`~${fmt(unused)} sf unused buildable — ${Math.round(envPct)}% of the ${maxFar.toFixed(1)} FAR envelope is unbuilt (built FAR ${built.toFixed(2)}).`);
  else drivers.push(`Built FAR ${built.toFixed(2)} of ${maxFar.toFixed(1)} max — limited additional floor area as-of-right.`);
  if (b.lotArea) drivers.push(`${fmt(b.lotArea)} sf lot${b.lotFront && b.lotDepth ? ` (${fmt(b.lotFront)} × ${fmt(b.lotDepth)} ft)` : ""}${b.lotArea >= 5000 ? " — a developable footprint, not a sliver" : ""}.`);
  if (age) drivers.push(`Built ${b.yearBuilt} (${age} yrs)${age >= 70 ? " — old enough that systems/use may be functionally obsolete" : ""}.`);
  if (b.assessLand && b.assessTotal && b.assessLand / b.assessTotal > 0.6) drivers.push(`Assessed land $${fmt(b.assessLand)} of $${fmt(b.assessTotal)} total — land-heavy assessment signals value in the dirt, not the structure.`);
  if (b.permitCount) drivers.push(`${b.permitCount} recent permit${b.permitCount === 1 ? "" : "s"} on record — active work or owner engagement to read into.`);
  if (b.specialDistrict) drivers.push(`Inside special district "${b.specialDistrict}" — district rules can override base zoning; confirm controlling text.`);
  const core = unused > 500 && envSf > 0
    ? `about ${Math.round(envPct)}% of its as-of-right envelope is unbuilt (~${fmt(unused)} sf of buildable left on the table), so the lot is materially underdeveloped against its ${maxFar.toFixed(1)} FAR ceiling`
    : `it is close to its ${maxFar.toFixed(1)} FAR ceiling, so the angle is repositioning, assemblage, or air-rights rather than new floor area on this lot alone`;
  const ageLine = age >= 70 ? ` A ${b.yearBuilt} structure of this age is often functionally obsolete, which strengthens the case for redevelopment or gut repositioning.` : "";
  return { tier, headline: `${tier} — lot, ${b.zoning ?? "zoning n/a"}.`,
    thesis: `This parcel ${verb}. On the live public record, ${core}.${ageLine} ${b.lotArea && b.lotArea >= 5000 ? "The footprint is large enough to underwrite seriously, " : ""}and the assessment${b.assessLand && b.assessTotal && b.assessLand / b.assessTotal > 0.5 ? ", which is weighted toward land," : ""} frames where the value actually sits. Use the contacts and live permit / ownership / sales evidence below to confirm ownership intent, debt position, and any active filings before acting.`,
    drivers, caveat: "Derived from public records + a modeled dev score, not a valuation. Verify zoning/overlay/special-district text, achievable FAR, and title/debt before underwriting." };
}

// --- Qualifiers
export function qualifiers(p) {
  const envPct = p.maxFar > 0 ? (Math.max(0, p.maxFar - p.far) / p.maxFar) : 0;
  const density = p.unbuiltFarSf > 15e4 ? "Institutional-scale density" : p.unbuiltFarSf > 6e4 ? "Meaningful mid-market density" : p.unbuiltFarSf > 0 ? "Infill-scale density" : "No unused FAR signal";
  const exec = p.risk === "Low" ? "Cleaner execution profile" : p.risk === "Moderate" ? "Diligence-dependent execution" : "Complex execution; price must compensate";
  const src = p.signals.length >= 3 ? "Multi-source signal stack" : "Thin public-signal stack";
  return [
    { title: "Opportunity type", value: p.category, detail: `${p.category} with ${p.opportunityScore}/100 conviction. Current model classifies this as ${p.status.toLowerCase()} based on parcel attributes, policy catalysts, and execution risk.` },
    { title: "Density math", value: density, detail: `${p.far.toFixed(1)} built FAR versus ${p.maxFar.toFixed(1)} modeled max FAR. Unused FAR is ${fmt(p.unbuiltFarSf)} sf, representing roughly ${Math.round(envPct * 100)}% of allowable density still to test.` },
    { title: "Execution posture", value: exec, detail: `Risk is marked ${p.risk.toLowerCase()} because of: ${p.riskFlags.join("; ")}. Pricing, contract structure, and timing should be adjusted around these issues before outreach.` },
    { title: "Policy catalyst", value: p.policyCatalysts[0] ?? "No named catalyst", detail: p.policyCatalysts.length ? `Catalyst stack: ${p.policyCatalysts.join(", ")}. These should be verified against the controlling zoning text, map amendments, eligibility rules, and effective dates.` : "No policy catalyst is currently attached; validate as-of-right economics without incentive upside." },
    { title: "Source strength", value: src, detail: `Modeled source stack: ${p.signals.join(", ")}. The dossier reconciles these live sources automatically by block/lot; resolving to one exact BBL tightens the same pull to a single parcel.` }
  ];
}

// --- Deep intelligence spine (evidence tiles), fed by /api/livepull data
export function evidenceSpine(p, live, links) {
  const money = (v) => (v != null && Number.isFinite(+v) && +v > 0 ? `$${Math.round(+v).toLocaleString()}` : null);
  const last = live?.summary?.lastSale ?? null;
  const debt = live?.debt ?? null;
  const s = live?.summary ?? null;
  const hasBin = p.bin && p.bin !== "0000000";
  const saleFields = [
    last?.saleDate ? `Last sale ${money(last.salePrice) ?? "(no price)"} · ${String(last.saleDate).slice(0, 10)}` : "No live arm's-length sale on the rolling file",
    last?.buildingClass ? `Class at sale: ${last.buildingClass}` : null,
    debt?.found ? `Recorded debt ${money(debt.amount) ?? ""}${debt.lender ? ` · ${debt.lender}` : ""}`.trim() : "No recorded mortgage found",
    p.owner ? `Owner of record: ${p.owner}` : null
  ].filter(Boolean);
  const sfFields = [
    p.lotSf ? `Lot ${fmt(p.lotSf)} sf` : null, p.bldgSf ? `Built ${fmt(p.bldgSf)} sf` : null,
    `FAR ${p.far.toFixed(1)} of ${p.maxFar.toFixed(1)} max`,
    p.unbuiltFarSf > 0 ? `Unused FAR ${fmt(p.unbuiltFarSf)} sf` : "No unused FAR",
    p.estLandPpbsf ? `Land basis proxy $${p.estLandPpbsf}/bsf` : null
  ].filter(Boolean);
  const zoningFields = [
    p.zoning ? `District ${p.zoning}` : null, p.landUse ? `Land use: ${p.landUse}` : null,
    s ? `${s.zoningApplicationCount} ZAP application${s.zoningApplicationCount === 1 ? "" : "s"} on file` : null,
    p.policyCatalysts.length ? `Catalysts: ${p.policyCatalysts.join(", ")}` : "No incentive catalyst attached"
  ].filter(Boolean);
  const dobFields = s
    ? [`${s.dobPermitCount} permit${s.dobPermitCount === 1 ? "" : "s"}`, `${s.dobNowCount} recent filing${s.dobNowCount === 1 ? "" : "s"}`, hasBin ? `BIN ${p.bin}` : "No BIN — vacant lot / no building", `Built ${p.yearBuilt || "—"}${p.floors ? ` · ${p.floors} floors` : ""}`]
    : [hasBin ? `BIN ${p.bin}` : "No BIN — vacant lot", `Built ${p.yearBuilt || "—"}`];
  return [
    { title: "Every sale & transfer", status: last?.saleDate || debt?.found ? "Live record pulled" : isExactAddress(p) ? "Live BBL pull" : "Block/lot pull", source: "Recorded sales + recorded documents",
      links: [{ label: "Recorded documents", url: links.acris }, { label: "Parcel & sales", url: links.propPortal }],
      detail: last?.saleDate
        ? `Last recorded sale ${money(last.salePrice) ?? "(price not stated)"} on ${String(last.saleDate).slice(0, 10)}${debt?.found ? `; current recorded debt ${money(debt.amount) ?? "on file"}${debt.lender ? ` from ${debt.lender}` : ""}` : "; no recorded mortgage found"}. Older transfers and full party detail load in the Parcel Dossier.`
        : "No arm's-length sale on the current rolling file. Open the full Parcel Dossier for the complete recorded deed/mortgage chain back to 1966.",
      fields: saleFields },
    { title: "Square-footage & density", status: "Parcel reconciled", source: "Parcel + zoning lot",
      links: [{ label: "Parcel record", url: links.propPortal }, { label: "Zoning lot", url: links.zola }],
      detail: p.unbuiltFarSf > 0
        ? `${p.far.toFixed(1)} of ${p.maxFar.toFixed(1)} FAR is built, leaving roughly ${fmt(p.unbuiltFarSf)} sf of unused development rights to test against constraints.`
        : `Effectively built out at ${p.far.toFixed(1)} of ${p.maxFar.toFixed(1)} FAR — value here is repositioning/conversion, not added density.`,
      fields: sfFields },
    { title: "Neighborhood / Plan Context", status: "Live planning watch", source: "Zoning map + planning applications",
      links: [{ label: "Zoning map (this lot)", url: links.zola }, { label: "Planning applications", url: "https://zap.planning.nyc.gov/projects" }],
      detail: p.policyCatalysts.length
        ? `${p.zoning || "Zoning"} with ${p.policyCatalysts.join(", ")} in play — confirm each against the controlling text, map amendments, and effective dates for this exact BBL.`
        : `${p.zoning || "Zoning"} with no incentive catalyst attached; underwrite as-of-right economics.`,
      fields: zoningFields },
    { title: "Build pipeline", status: s ? "Live counts pulled" : hasBin ? "Live BIN pull" : "Live BBL pull", source: "Permit records",
      links: [{ label: "Buildings profile", url: links.bisweb }, { label: "Permit portal", url: "https://a810-dobnow.nyc.gov/publish/Index.html#!/" }],
      detail: s
        ? `${s.dobPermitCount} permit(s) and ${s.dobNowCount} recent filing(s) resolved for this parcel${s.dobNowCount === 0 && s.dobPermitCount === 0 ? " — quiet permit history, consistent with a long-held or pre-development lot." : "."}`
        : "Permit and job-filing history pulls live by BIN/BBL — open the dossier to refresh.",
      fields: dobFields },
    { title: "Taxes, assessment & incentives", status: "Assessment + incentive watch", source: "Assessment roll + recorded documents",
      links: [{ label: "Assessment & taxes", url: links.propPortal }, { label: "Recorded documents", url: links.acris }],
      detail: p.policyCatalysts.length
        ? `Incentive watch: ${p.policyCatalysts.join(", ")}. Validate tax class, assessed value, abatement burn-off, and post-stabilization tax basis before underwriting.`
        : "No incentive attached — validate tax class, assessed value, and any abatement burn-off before underwriting.",
      fields: [p.estLandPpbsf ? `Land basis proxy $${p.estLandPpbsf}/bsf` : "Land basis: run comps", p.policyCatalysts.length ? `Incentives: ${p.policyCatalysts.join(", ")}` : "As-of-right"] },
    { title: "Regulatory & physical risk", status: "Diligence overlay", source: "Building & housing violations + flood/landmark",
      links: [{ label: "Building violations", url: links.bisweb }, { label: "Zoning flood / landmark", url: links.zola }],
      detail: `Risk marked ${p.risk.toLowerCase()}${p.riskFlags.length ? `: ${p.riskFlags.join("; ")}` : ""}. Live building & housing violation counts, flood, landmark and E-designation load on the exact BBL in the Parcel Dossier.`,
      fields: p.riskFlags.length ? p.riskFlags.slice(0, 4) : ["No major flags modeled"] }
  ];
}

// --- Contact strategy
export function contactStrategy(p, debt, permitContact, plutoOwner) {
  const money = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? `$${Math.round(n).toLocaleString()}` : "amount not stated"; };
  const d10 = (d) => (d ? String(d).slice(0, 10) : "date n/a");
  const out = [];
  if (debt?.found && debt.borrower) {
    out.push({ role: "Owner / decision-maker",
      target: `${debt.borrower} (borrower/mortgagor of record on the latest recorded ${debt.docTypeLabel ?? "mortgage"}, doc ${debt.documentId})`,
      rationale: `Pulled automatically from recorded documents — this party signed the most recent recorded debt against the lot (${d10(debt.recordedDate)}). It is the entity to reach for any acquisition, recap, or JV, alongside the modeled owner "${p.owner}".`,
      verify: "The record gives the entity, not a named principal — principal/managing-member mapping via state business filings / OpenCorporates is a separate enrichment.",
      confidence: "Pulled from ownership records" });
  } else if (plutoOwner && plutoOwner.trim()) {
    out.push({ role: "Owner / decision-maker", target: `${plutoOwner} (registered owner of record)`,
      rationale: `Pulled automatically from the property record for this lot. It is the counterparty for any acquisition, recap, or JV conversation; the modeled record names "${p.owner}".`,
      verify: "The property record gives the registered owner name; no recorded mortgage party resolved for this lot. Principal mapping via state business filings is a separate enrichment.",
      confidence: "Pulled from property records" });
  } else {
    out.push({ role: "Owner / decision-maker", target: `${p.owner} (modeled ownership entity)`,
      rationale: "Counterparty for any acquisition, recap, or JV conversation. The named entity is modeled from the recorded party schema.",
      verify: "Automated public-record pulls returned no live owner party for the current identifier (expected for a demo BBL or a corridor record). The pull re-runs automatically when the lot resolves.",
      confidence: "Automated — no record found" });
  }
  if (debt?.found && debt.lender) {
    out.push({ role: "Lender / debt contact",
      target: `${debt.lender} (mortgagee of record · ${debt.docTypeLabel ?? "mortgage"} · ${money(debt.amount)} · recorded ${d10(debt.recordedDate)})`,
      rationale: `Pulled automatically from recorded doc ${debt.documentId}${debt.borrower ? `, borrower ${debt.borrower}` : ""}. Loan vintage and any maturity/refi pressure frame the owner's timing and motivation.`,
      verify: "The public record gives the institution, amount, and recording date — it does NOT publish a named officer or email. The relationship officer is the one item still requiring institution-side enrichment.",
      confidence: "Pulled from ownership records" });
  } else if (p.signals.includes("ACRIS") || p.category === "Active Construction" || p.riskFlags.some((f) => /tenant|occup|maturit|debt|loan|recap/i.test(f))) {
    out.push({ role: "Lender / debt contact", target: "No recorded mortgage on this lot (automated public-record pull)",
      rationale: "Loan vintage and maturity can force a sale, recap, or workout. The automated pull searched this borough/block/lot and returned no debt-class document — the lot is unencumbered, the debt predates the digital index, or this is a demo identifier.",
      verify: "The public-record pull re-runs automatically on refresh and when the lot resolves to an exact BBL; if a mortgage exists it surfaces the lender, amount, and recording date here without any manual lookup.",
      confidence: "Automated — no record found" });
  }
  const permitLikely = p.bin !== "0000000" && (p.category === "Active Construction" || p.adaptiveReuse || p.policyCatalysts.length > 0 || p.signals.includes("DOB"));
  if (permitContact?.found) {
    const who = [permitContact.applicantBusiness, permitContact.applicant].filter(Boolean).join(" — ") || "Applicant of record";
    out.push({ role: "Architect / expeditor / permit contact", target: who,
      rationale: "Pulled automatically from the most recent filing for this BIN/BBL. The applicant of record (architect or expeditor) and any owner business reveal the owner's actual intent and the live entitlement path.",
      verify: "Applicant, owner-business, and license/cert are public-record fields on the filing. A direct phone/email is not published in the open dataset and is the only item requiring enrichment.",
      confidence: "Pulled from permit records" });
  } else if (permitLikely) {
    out.push({ role: "Architect / expeditor / permit contact", target: "No applicant of record on file (automated permit pull)",
      rationale: "The applicant on the latest permit filing reveals the owner's intent and entitlement path.",
      verify: "The automated permit pull returned no applicant for this BIN/BBL (expected for a demo identifier or a lot with no recent filing). It re-runs automatically on refresh.",
      confidence: "Automated — no record found" });
  }
  out.push({ role: "Broker / advisor",
    target: p.category === "On-Market Signal" ? "Listing/advisory broker on the active marketing process" : "Investment-sales advisor active in this submarket",
    rationale: p.category === "On-Market Signal" ? "A live process means there is already an advisor controlling access and timeline." : "An off-market angle still benefits from the advisor who has covered the owner or the block.",
    verify: "Not publicly available from NYC open data — enrich via CRM / relationship database or active-listing coverage. There is no authoritative public dataset to automate this from.",
    confidence: "Not in public records" });
  return out;
}

// --- So What — client call angle
export function soWhatBlock(p) {
  const exact = isExactAddress(p);
  const n = p.unbuiltFarSf;
  const densityLine = n > 0 ? `~${fmt(n)} sf of unused FAR still to test (${p.far.toFixed(1)} built vs ${p.maxFar.toFixed(1)} max)` : "fully or near-fully built — value is in repositioning/conversion, not added density";
  const why = [
    `${p.category} in ${p.neighborhood} scoring ${p.opportunityScore}/100 on the current model.`,
    `Density math: ${densityLine}.`,
    p.policyCatalysts[0] ? `Policy catalyst in play: ${p.policyCatalysts.join(", ")} — confirm eligibility against the controlling text and effective dates.` : "No incentive catalyst attached; the thesis must clear on as-of-right economics alone."
  ];
  if (p.adaptiveReuse) why.push("Sits inside the adaptive-reuse / 467-m conversion lane, which widens the buyer pool and exit options.");
  const soWhat = p.adaptiveReuse
    ? `So what: ${p.address} is a conversion/repositioning play where the value swing is the entitlement and unit-mix outcome — exactly the decision a client wants help pressure-testing before they commit capital.`
    : n > 6e4
      ? `So what: ${p.address} carries real unused density (${fmt(n)} sf), so the client conversation is about how much of that allowable FAR actually pencils after constraints.`
      : `So what: ${p.address} is a control/repositioning story more than a density story — the angle for the client is timing, basis, and execution risk rather than raw buildable square footage.`;
  const hook = exact
    ? `"We mapped ${p.address} against live public records and flagged it as a ${p.opportunityScore}/100 ${p.category.toLowerCase()} — wanted to walk you through what we're seeing before it's obvious to everyone."`
    : `"We're tracking the ${p.neighborhood} corridor and ${p.address} screens as a ${p.category.toLowerCase()}. We'd tighten it to the exact lot for you before you spend any real time on it."`;
  const lowRisk = p.risk === "Low" || p.risk === "Moderate";
  const objection = lowRisk ? `"We've already seen everything in that submarket / our team covers it."` : `"That deal looks complicated — ${p.riskFlags[0] ?? "execution risk"} makes it hard to underwrite."`;
  const response = lowRisk
    ? `We're not pitching the obvious comps — we pull the lot across live public sources automatically and surface the ${p.policyCatalysts[0] ?? "as-of-right"} angle and ownership/debt timing most desks skip. That's where the edge is.`
    : `That complexity is the point — risk (${p.riskFlags.join("; ")}) is what keeps the price honest. We quantify each item against reserves, schedule, and basis so you bid the risk instead of avoiding the asset.`;
  const ask = exact
    ? `Ask for a 20-minute working session: we bring the live-data pull and conversion/underwriting model for ${p.address}; the client tells us if the basis and execution fit their box. Next step on our side: ${p.nextAction.toLowerCase()}.`
    : `Ask for permission to tighten this to the exact lot and send a one-page live-data brief. Next step on our side: ${p.nextAction.toLowerCase()}.`;
  return { soWhat, whyItMatters: why, outreachHook: hook, likelyObjection: objection, response, recommendedAsk: ask };
}

// --- Diligence framework
export function diligenceFramework(p) {
  return [
    { title: "Identity confirmation", items: [
      isExactAddress(p) ? "Address resolves to one BBL; the dossier pulls parcel and zoning records automatically against it." : "Corridor record: the dossier pulls by block/lot automatically; resolving to one lot tightens the same pull.",
      "BBL, BIN, block, lot, owner name, zoning lot, lot area, building area, and year built are matched across public records by the live pull.",
      "Any mismatch is surfaced as a data-timing, multi-lot, or condominium signal in the evidence tiles." ] },
    { title: "Ownership and control", items: [
      "Pull current deed, last arm's-length transfer, mortgages, satisfactions, UCC/lien signals, and party names from the recorded documents.",
      "Identify direct owner, beneficial owner clues, lender, loan vintage, maturity pressure, recapitalization triggers, and entity address.",
      "For assemblages, map each owner separately and sequence outreach by control leverage, holdout risk, and lot criticality." ] },
    { title: "Zoning and entitlement", items: [
      "Verify zoning district, commercial overlays, special districts, MIH, inclusionary housing, height/setback, parking, waterfront, landmark, and floodplain rules.",
      "Model as-of-right, discretionary, incentive, and fallback programs separately so land value does not depend on one entitlement path.",
      "Confirm whether 467-m, 485-x, MIH, Gowanus, OneLIC, City of Yes, or other catalysts actually apply to the exact BBL." ] },
    { title: "Physical and environmental", items: [
      "Screen prior use, auto/industrial history, E-designations, brownfield indicators, flood zone, cellar/basement exposure, and adjacent infrastructure.",
      "Test demolition, vertical enlargement, adaptive reuse, light-and-air, core relocation, MEP, egress, and facade constraints.",
      "Translate physical risk into reserve, schedule, lender, insurance, and price-adjustment assumptions." ] },
    { title: "Market and underwriting", items: [
      "Benchmark land $/bsf, rents, condo sellout, concessions, lease-up, construction cost, cap-rate, financing, tax benefit, and affordable requirement scenarios.",
      "Compare against the app's comp set, then replace demo comps with verified live comps before client-facing valuation.",
      `Immediate next action: ${p.nextAction}.` ] }
  ];
}

// --- Seller-propensity (browser copy, identical to server model)
export function propensityFor(b, nowYear = new Date().getFullYear()) {
  const owner = (b.owner ?? "").toUpperCase();
  if (owner && /\bCITY OF\b|\bNYC\b|STATE OF NEW ?YORK|UNITED STATES|DEPARTMENT OF|\bAUTHORITY\b|\bNYCHA\b|\bMTA\b|CON ?ED|PUBLIC SCHOOL|POST OFFICE/.test(owner)) {
    return { score: 0, band: "Low", reasons: [], components: [], excluded: "Government / transit / utility / authority owner — excluded (does not sell to private buyers)." };
  }
  const comps = [];
  const age = b.yearBuilt && b.yearBuilt > 1800 ? nowYear - b.yearBuilt : null;
  if (age != null && age >= 90) comps.push({ label: "Aging structure", points: 14, detail: `Built ${b.yearBuilt} — ${age} years old; systems/use often functionally dated, which strengthens the case for a sale or gut repositioning.`, source: "Public record · yearbuilt" });
  else if (age != null && age >= 60) comps.push({ label: "Older structure", points: 7, detail: `Built ${b.yearBuilt} (${age} yrs).`, source: "Public record · yearbuilt" });
  const unusedFar = b.maxFar && b.maxFar > 0 ? Math.max(0, b.maxFar - (b.builtFar || 0)) : 0;
  const unusedSf = b.lotArea ? Math.round(unusedFar * b.lotArea) : 0;
  const share = b.maxFar > 0 ? unusedFar / b.maxFar : 0;
  if (unusedSf > 5e4 && share > 0.5) comps.push({ label: "Major unused development rights", points: 24, detail: `${fmt(unusedSf)} sf of unused FAR — built ${(b.builtFar ?? 0).toFixed(2)} of ${(b.maxFar ?? 0).toFixed(2)} max FAR on a ${fmt(b.lotArea ?? 0)} sf lot (${Math.round(share * 100)}% of the envelope unbuilt). Owners sitting on this much air rights either build or sell.`, source: "Public record · builtfar / residfar / commfar / lotarea" });
  else if (unusedSf > 15e3 && share > 0.4) comps.push({ label: "Meaningful unused FAR", points: 13, detail: `${fmt(unusedSf)} sf of unused FAR (${Math.round(share * 100)}% of the envelope unbuilt) — monetizable development rights.`, source: "Public record · builtfar / lotarea" });
  if (b.assessLand && b.assessTotal && b.assessTotal > 0 && b.assessLand / b.assessTotal >= 0.75) {
    comps.push({ label: "Land-heavy assessment", points: 12, detail: `${Math.round((b.assessLand / b.assessTotal) * 100)}% of assessed value is land ($${fmt(b.assessLand)} of $${fmt(b.assessTotal)}) — the City's assessor puts the value in the dirt, the classic teardown/redevelopment profile.`, source: "Public record · assessland / assesstot" });
  }
  const institutional = /LLC|L\.L|\bINC\b|CORP|\bLP\b|L\.P|REIT|ASSOC|PARTNER|REALTY|MANAGEMENT|MGMT|HOLDING|TRUST|FUND|PROPERT|GROUP|CHURCH|HOSPITAL/.test(owner);
  if (owner && !institutional) comps.push({ label: "Individual / non-institutional owner", points: 11, detail: `Owner of record "${b.owner}" reads as an individual, not an institution — estate, generational-transfer, and tax-basis-reset motivations cluster here.`, source: "Public record · ownername" });
  if ((b.permitCount || 0) === 0 && (age == null || age > 40)) comps.push({ label: "No reinvestment", points: 6, detail: "No permits on record for an older building — an owner not putting capital in is more open to an exit.", source: "Public record · permits by lot" });
  if ((b.unitsRes || 0) >= 4 && (b.unitsRes || 0) <= 30 && !institutional) comps.push({ label: "Small multifamily, individual hands", points: 6, detail: `${b.unitsRes} residential units under individual ownership — the operationally-tiring size that turns over.`, source: "Public record · unitsres / ownername" });
  const score = Math.min(100, comps.reduce((n, c) => n + c.points, 0));
  const band = score >= 55 ? "High" : score >= 35 ? "Elevated" : score >= 18 ? "Watch" : "Low";
  return { score, band, reasons: comps.map((c) => c.detail), components: comps };
}

// --- Distress / motivated-seller model (mirrors the server's)
const MTGE_RE = /MORTGAGE|MTGE|AGREEMENT|CONSOLIDAT|GAP|SUPPLEMENT/i;
const SAT_RE = /SATISF|RELEASE|DISCHARGE/i;
const yearOfDoc = (d) => { const y = parseInt(String(d ?? "").slice(0, 4), 10); return Number.isFinite(y) && y > 1900 ? y : null; };
export function estimateDebtMaturity(record, nowYear = new Date().getFullYear()) {
  const loans = Array.isArray(record?.loans) ? record.loans : [];
  if (!loans.length) return null;
  const primary = loans.filter((m) => MTGE_RE.test(String(m.docType || "")) && !SAT_RE.test(String(m.docType || "")) && (m.amount ?? 0) > 0)[0] ?? loans[0];
  const y = yearOfDoc(primary?.date);
  if (!primary || !y) return null;
  const term = 10, maturity = y + term;
  const laterSat = loans.some((m) => SAT_RE.test(String(m.docType || "")) && (yearOfDoc(m.date) ?? 0) > y);
  const status = maturity <= nowYear ? "past" : maturity - nowYear <= 2 ? "approaching" : "seasoned";
  return { amount: primary.amount ?? 0, date: primary.date, lender: primary.lender || "—", estTermYears: term, estMaturityYear: maturity, status,
    note: laterSat ? "A later satisfaction/release is on record — this loan may already be repaid; verify the current cap stack in the recorded documents." : `Assumes a ~${term}-yr term from the ${y} recording; confirm the actual maturity in the mortgage document.` };
}
export function distressFromRecord(record, nowYear = new Date().getFullYear()) {
  const reasons = [];
  const debt = estimateDebtMaturity(record, nowYear);
  let score = 0;
  if (debt?.status === "past") { score += 30; reasons.push({ label: "Debt past estimated maturity", weight: 30, detail: `~$${Math.round(debt.amount).toLocaleString()} loan from ${debt.lender} recorded ${String(debt.date).slice(0, 4)}; on a ~${debt.estTermYears}-yr term it would mature around ${debt.estMaturityYear}. A loan past maturity with no recorded refinance is real refinance pressure.` }); }
  else if (debt?.status === "approaching") { score += 15; reasons.push({ label: "Debt approaching maturity", weight: 15, detail: `~$${Math.round(debt.amount).toLocaleString()} loan estimated to mature ~${debt.estMaturityYear}. Owners often transact ahead of a refinance in a higher-rate market.` }); }
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

// --- Outreach drafting
function salutation(owner) {
  const t = (owner || "").trim();
  const m = t.match(/^\s*([^,]+),\s*([^,]+?)\s*$/);
  if (!m || /LLC|CORP|TRUST|LP|INC/i.test(t)) return "Hello,";
  const cap = (s) => s.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  return `Dear ${cap(m[2])} ${cap(m[1])},`;
}
export function outreachAngle(ctx) {
  const c = ctx.cliffs;
  if (c?.ll97?.status === "exposed" && c.ll97.penalty2030 > 0) return `the building's Local Law 97 carbon exposure steps up in 2030 — by my read that's roughly $${c.ll97.penalty2030.toLocaleString()}/yr in penalties most buyers haven't priced. That's far easier to address from a position of choice than against a deadline.`;
  if (c?.j51?.status === "expiring") return `the J-51 benefit looks like it burns off around ${c.j51.endYear}, which resets the carrying cost. Getting ahead of that, rather than reacting to it, is usually worth real money.`;
  if (ctx.sig?.debt?.status === "past") return "the financing on record looks like it's past its likely maturity — refinancing into today's rates isn't fun, and a clean, quiet sale is often the better outcome.";
  if (ctx.sig?.debt?.status === "approaching") return `the financing looks like it matures around ${ctx.sig.debt.estMaturityYear} — worth thinking through your options before the clock forces the decision.`;
  if (ctx.prop?.components?.find((x) => /unused FAR|development rights/i.test(x.label))) return "you're sitting on meaningful unused development rights here — that value is real whether you build it or sell it, and there's live demand for it.";
  if (ctx.prop?.components?.find((x) => /land-heavy/i.test(x.label))) return `the value here is mostly in the land — exactly the profile that's drawing aggressive bids in ${ctx.neighborhood || "this market"} right now.`;
  if ((ctx.metrics?.holdYears ?? 0) >= 20) return "you've held this a long time — if a tax-efficient exit ever made sense, I'd want to be the one who brings you the number.";
  return `I have active buyers for ${ctx.assetLabel?.toLowerCase() || "assets"} in ${ctx.neighborhood || "the area"} and wanted to reach out directly rather than through the noise.`;
}
export function outreachDraft(ctx) {
  const by = ctx.preparedBy || "Your name";
  const angle = outreachAngle(ctx);
  const hood = ctx.neighborhood ? ` in ${ctx.neighborhood}` : "";
  const email = `${salutation(ctx.owner)}\n\nI cover ${ctx.neighborhood || "this market"} block by block, and ${ctx.address} stands out to me — ${angle}\n\nI'm not asking you to list it. If the number is right and the process stays quiet, would you be open to a short call? I can put a real, supportable value in front of you this week, no obligation.\n\nBest,\n${by}`;
  const letter = `${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}\n\nRe: ${ctx.address}${hood}\n\n${salutation(ctx.owner)}\n\nI work ${ctx.neighborhood || "this market"} closely and have been following ${ctx.address} for some time. I'm reaching out directly because ${angle}\n\nI'm not suggesting you put it on the market. What I am offering is a quiet, no-obligation conversation and a real, supportable opinion of value — the kind of read that lets you make a decision from information rather than pressure. If the timing is ever right, I'd like to be the person who brings you a clean offer and a discreet process.\n\nI'd welcome a brief call at your convenience.\n\nSincerely,\n${by}`;
  return { subject: ctx.address, email, letter };
}

// --- Narrative synthesis ("The story")
export function storyParagraphs(record) {
  if (!record) return [];
  const r = record.pluto;
  const name = record.address || `BBL ${record.bbl}`;
  const year = new Date().getFullYear();
  const out = [];
  if (r) {
    const age = r.yearBuilt && r.yearBuilt > 1800 ? year - r.yearBuilt : null;
    let s = `${name} is a ${r.landUse ? r.landUse.toLowerCase() : ""} property`.replace("  ", " ");
    if (r.yearBuilt && r.yearBuilt > 1800) s += ` built in ${r.yearBuilt}${age ? ` (${age} years old)` : ""}`;
    if (r.yearAlter1) s += `, with major alterations in ${r.yearAlter1}`;
    s += ". ";
    const bits = [];
    if (r.zoning) bits.push(`zoned ${r.zoning}`);
    if (r.bldgClass) bits.push(`building class ${r.bldgClass}`);
    if (r.unitsRes != null) bits.push(`${r.unitsRes} residential units`);
    if (r.bldgArea) bits.push(`${fmt(r.bldgArea)} sf built`);
    if (r.builtFar != null && r.maxFar) bits.push(`${r.builtFar.toFixed(1)} of ${r.maxFar.toFixed(1)} FAR used`);
    if (bits.length) s += `It is ${bits.join(", ")}.`;
    out.push(s);
  }
  const m = record.metrics;
  if (m?.lastSaleDate) {
    let s = `${r?.owner ? `Current owner ${r.owner} has` : "The current owner has"} held it about ${m.holdYears ?? "—"} years, since the ${String(m.lastSaleDate).slice(0, 4)} purchase`;
    if (m.lastSalePrice) s += ` for $${fmt(m.lastSalePrice)}`;
    if (m.lastSalePpsf) s += ` (~$${fmt(m.lastSalePpsf)}/sf)`;
    out.push(s + ".");
  } else if (r?.owner) {
    out.push(`Current owner of record is ${r.owner}; no arm's-length deed price is on file (often a long-held or transferred-by-entity asset).`);
  }
  const depth = [];
  if (record.sales?.length) depth.push(`${record.sales.length} recorded deed${record.sales.length === 1 ? "" : "s"}`);
  if (record.loans?.length) depth.push(`${record.loans.length} financing record${record.loans.length === 1 ? "" : "s"}`);
  if (record.permits?.length) depth.push(`${record.permits.length} permit filing${record.permits.length === 1 ? "" : "s"}`);
  if (depth.length) {
    let s = `The public record runs deep: ${depth.join(", ")}.`;
    const loan = record.loans?.[0];
    if (loan && loan.amount > 0) s += ` Most recent financing on file: $${fmt(loan.amount)} from ${loan.lender} (${String(loan.date).slice(0, 4)}).`;
    out.push(s);
  }
  const ppsfs = (record.comps ?? []).map((c) => c.ppsf).filter(Boolean).sort((a, b) => a - b);
  if (ppsfs.length >= 2) {
    const med = ppsfs.length % 2 ? ppsfs[(ppsfs.length / 2) | 0] : Math.round((ppsfs[ppsfs.length / 2 - 1] + ppsfs[ppsfs.length / 2]) / 2);
    let s = `Comparable ${r?.bldgClass ? r.bldgClass[0] : ""}-class sales nearby (same ZIP, last 24 months) have run a median of about $${fmt(med)}/sf`;
    if (m?.lastSalePpsf) {
      const d = Math.round(((m.lastSalePpsf - med) / med) * 100);
      s += `, putting this asset's last trade ${d === 0 ? "right in line with" : `${Math.abs(d)}% ${d > 0 ? "above" : "below"}`} the local comp set`;
    }
    out.push(s + ".");
  }
  return out;
}

// --- Policy watch library (used by market report + territory)
export const POLICY_LL97 = { title: "Local Law 97 — building carbon caps", status: "Effective", summary: "Buildings over 25,000 sf face emissions limits, with penalties live since 2024 and materially stricter caps from 2030. Factor retrofit capex (electrification, envelope, controls) and potential fines into hold-period budgets and exit assumptions." };
export const POLICY_COY_CONV = { title: "City of Yes — expanded conversion rights", status: "Enacted", summary: "Conversion of non-residential buildings to housing is now allowed citywide for any building existing on or before Dec 31, 1990 — a far broader universe than before. Creates a residential backstop for under-performing commercial space." };
export const POLICY_WATCH = {
  multifamily: { heading: "Rent-law & tax watch — what it means for owners here", intro: "The items most likely to move NOI, value, and exit timing for an apartment owner in this market:", items: [
    { title: "Good Cause Eviction (NYC)", status: "Effective", summary: "Effective April 2024 in NYC. For covered market-rate units it caps most annual increases to a local standard (roughly CPI + 5%, ~10% ceiling) and requires good cause to refuse renewal. Newer construction (first 15 years), small owner-occupied buildings, and high-rent units are exempt. Underwrite covered units closer to a regulated-growth profile rather than open-market mark-to-market." },
    { title: "HSTPA 2019 rent-stabilization regime", status: "Effective", summary: "Stabilization is permanent with capped IAI/MCI recovery and no high-rent deregulation. Value-add through vacancy decontrol is off the table; stabilized NOI growth is limited to RGB-set increases — price stabilized stock accordingly." },
    { title: "485-x (Affordable Neighborhoods for New Yorkers)", status: "Enacted", summary: "The 421-a successor: long-term tax exemption for new rental construction, with affordability and construction-wage floors that scale by project size. Shapes the pipeline of competing new rental supply in this submarket." },
    POLICY_LL97 ] },
  development: { heading: "Zoning & entitlement watch — what it means for development here", intro: "The regulatory moves that change what you can build, how much, and whether it pencils:", items: [
    { title: "City of Yes for Housing Opportunity", status: "Enacted", summary: "Adopted Dec 2024 (with neighborhood plans enacted Dec 2025) — the biggest zoning overhaul since 1961. The Universal Affordability Preference adds at least ~20% density above base FAR for permanently affordable housing, town-center and transit-oriented provisions unlock low-density corridors, and ADUs are broadly permitted. Re-test every site's buildable area under the new envelope." },
    { title: "Residential FAR cap repeal", status: "Enacted", summary: "The state lifted the 12.0 residential FAR ceiling in the 2024 budget, which is what lets City of Yes density bonuses actually apply on large sites. High-density parcels can now exceed the old cap where the local zoning permits." },
    { title: "Parking mandate removal (Zone 1)", status: "Enacted", summary: "Off-street parking minimums are eliminated in Zone 1 — Manhattan, Long Island City, and much of western Queens/Brooklyn — and reduced elsewhere. Removes a major cost and footprint constraint from urban-core projects." },
    { title: "485-x construction tax exemption", status: "Enacted", summary: "The 421-a replacement: the tax abatement most ground-up rental projects will rely on to pencil, with affordability and wage requirements tiered by size. Central to the rental development pro forma." },
    { title: "467-m commercial-to-residential conversion", status: "Enacted", summary: "Up to 35-year tax benefit for converting commercial buildings to housing, enhanced for projects in Manhattan south of 96th Street. Must commence by June 30, 2031. Opens conversion plays on obsolete office/commercial stock." } ] },
  office: { heading: "Policy watch — what it means for office owners here", intro: "The changes most likely to affect office value, repositioning options, and carrying cost:", items: [
    { title: "467-m office-to-residential conversion", status: "Enacted", summary: "Up to 35-year tax benefit for residential conversion, enhanced below 96th Street, for projects commencing by June 30, 2031. Combined with the new citywide conversion rights, this is a real value backstop for older or under-leased office assets." },
    POLICY_COY_CONV, POLICY_LL97,
    { title: "Midtown South Mixed-Use rezoning", status: "Enacted", summary: "One of the enacted neighborhood plans, allowing residential use across former office/manufacturing cores in Midtown South — relevant to repositioning optionality if the asset sits in or near the corridor." } ] },
  hotels: { heading: "Policy watch — what it means for hotel owners here", intro: "Supply and cost-of-ownership factors specific to NYC hotels:", items: [
    { title: "Citywide hotel special permit (ZR 74-803)", status: "Effective", summary: "Since 2021 new hotels require a City Planning Commission special permit citywide — a high bar that constrains new supply. That scarcity is generally supportive of existing hotel asset values." },
    POLICY_LL97, POLICY_COY_CONV ] },
  condo: { heading: "Policy watch — what it means for owners here", intro: "Regulatory context most relevant to condo / co-op and small-residential assets in this market:", items: [
    { title: "Good Cause Eviction — coverage notes", status: "Effective", summary: "Owner-occupied condos/co-ops and small owner-occupied buildings are generally outside Good Cause coverage, but investor-held rental units can be covered. Confirm unit-by-unit status before underwriting rent growth." },
    POLICY_LL97, POLICY_COY_CONV ] },
  misc: { heading: "Policy & zoning watch — what it means for this market", intro: "The citywide changes most likely to affect value and optionality across asset types here:", items: [
    { title: "City of Yes for Housing Opportunity", status: "Enacted", summary: "The 2024–2025 citywide rezoning adds affordable-density bonuses, removes parking mandates in the urban core, and broadly expands conversion rights — reshaping redevelopment optionality across the city." },
    POLICY_COY_CONV, POLICY_LL97 ] }
};

// Cap-rate / rent benchmark assumptions used by the market report
export const RENT_PSF = {
  multifamily: { Manhattan: 95, Brooklyn: 72, Queens: 66, Bronx: 55, default: 75 },
  condo: { Manhattan: 95, Brooklyn: 72, Queens: 66, Bronx: 55, default: 75 },
  office: { Manhattan: 82, Brooklyn: 55, Queens: 45, Bronx: 40, default: 60 },
  misc: { Manhattan: 110, Brooklyn: 70, Queens: 55, Bronx: 45, default: 65 }
};
export const VACANCY = { multifamily: 0.04, condo: 0.04, office: 0.15, misc: 0.1 };
export const OPEX = { multifamily: 0.45, condo: 0.45, office: 0.5, misc: 0.42 };
export const CAP_BANDS = {
  multifamily: { Manhattan: { low: 4, high: 5.5, note: "free-market ~4.0–5.0% · rent-stabilized ~5.0–5.5%" }, Brooklyn: { low: 4.75, high: 6, note: "free-market ~4.75–5.5% · rent-stabilized ~5.5–6.0%" }, Queens: { low: 5, high: 6.5, note: "free-market ~5.0–5.75% · rent-stabilized ~5.75–6.5%" }, Bronx: { low: 5.5, high: 7, note: "rent-stabilized-heavy stock; ~5.5–7.0%" }, default: { low: 5, high: 6.5, note: "outer-borough blended ~5.0–6.5%" } },
  condo: { Manhattan: { low: 4, high: 5.5, note: "free-market residential basis" }, Brooklyn: { low: 4.5, high: 6, note: "free-market residential basis" }, Queens: { low: 4.75, high: 6.25, note: "free-market residential basis" }, Bronx: { low: 5.25, high: 6.75, note: "free-market residential basis" }, default: { low: 4.75, high: 6.25, note: "free-market residential basis" } },
  office: { Manhattan: { low: 6, high: 8.5, note: "institutional-quality ~4.5–6.5%; broader market to ~8.5%" }, Brooklyn: { low: 6.5, high: 8.5, note: "~6.5–8.5% indicative" }, Queens: { low: 7, high: 9, note: "~7.0–9.0% indicative" }, Bronx: { low: 7.5, high: 9.5, note: "~7.5–9.5% indicative" }, default: { low: 6.5, high: 9, note: "~6.5–9.0% indicative" } },
  misc: { Manhattan: { low: 6, high: 7, note: "retail ~6.4–6.8%; industrial ~6–7% indicative" }, Brooklyn: { low: 6.25, high: 7.25, note: "retail/industrial ~6.25–7.25% indicative" }, Queens: { low: 6.5, high: 7.75, note: "retail/industrial ~6.5–7.75% indicative" }, Bronx: { low: 6.75, high: 8, note: "retail/industrial ~6.75–8.0% indicative" }, default: { low: 6.25, high: 7.5, note: "retail/industrial ~6.25–7.5% indicative" } }
};
export const LAND_BSF = { Manhattan: [300, 500], Brooklyn: [150, 300], Queens: [120, 250], Bronx: [90, 200], default: [120, 300] };
