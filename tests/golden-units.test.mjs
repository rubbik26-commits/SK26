// Golden unit tests (audit item 46): the scoring and underwriting engines are
// pinned to known-good numbers — any drift in the business math fails loudly.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { computePropensity, computeOpportunityScore, WEIGHTS } from "../server/scoring.js";
import { financeRollup, parseCompLines, readFiguresFromText, generateDealDoc } from "../public/js/lib/deal-docs.js";

const FIXED_BUILDING = {
  bbl: "1000010001", owner: "SMITH, JOHN", yearBuilt: 1925, unusedFarSf: 40000,
  lotArea: 5000, bldgArea: 12000, builtFar: 2.4, maxFar: 10,
  assessLand: 900000, assessTotal: 1100000, unitsRes: 8, unitsTotal: 9,
  borough: "Manhattan", permitCount: 0, bldgClass: "C7", landUse: "02"
};

test("original scoring weights are preserved (audit section A.3)", () => {
  assert.equal(WEIGHTS.density, 22);
  assert.equal(WEIGHTS.catalyst, 20);
  assert.equal(WEIGHTS.location, 18);
  assert.equal(WEIGHTS.execution, 18);
  assert.equal(WEIGHTS.conversion, 12);
  assert.equal(WEIGHTS.source, 10);
});

test("seller-propensity golden: aging walk-up in individual hands scores 62", () => {
  const p = computePropensity(FIXED_BUILDING);
  assert.equal(p.score, 62);
  assert.deepEqual(p.components.map((c) => c.label), [
    "Aging structure", "Meaningful unused FAR", "Land-heavy assessment",
    "Individual / non-institutional owner", "No reinvestment", "Small multifamily, individual hands"
  ]);
});

test("government owners are excluded from propensity", () => {
  const p = computePropensity({ ...FIXED_BUILDING, owner: "NYC DEPT OF HOUSING PRESERVATION" });
  assert.ok(p.excluded, "government-owned lot must be excluded, not scored");
});

const FIXED_DEAL = {
  property: { units: 8, sf: 12000, lot_sf: 5000 },
  financials: { gross_income: 612500, vacancy_pct: 0.05, opex: 228400 },
  underwriting: {
    asking_price: 6400000, market_cap_rate: 0.055,
    loan: { amount: 3840000, rate: 0.0625, amort_years: 30 },
    hold_years: 5, exit_cap: 0.055, noi_growth_pct: 0.02
  }
};

test("underwriting golden: NOI/EGI/cap/DSCR/IRR/multiple pinned", () => {
  const r = financeRollup(FIXED_DEAL);
  assert.equal(r.noi, 353475);
  assert.equal(r.egi, 581875);
  assert.equal(r.cap_rate, 0.05523);
  assert.equal(r.dscr, 1.246);
  assert.equal(r.returns.irr, 0.094);
  assert.equal(r.returns.equity_multiple, 1.536);
  assert.equal(r.ppu, 800000);
  assert.equal(r.returns.rows.length, 5);
  assert.ok(r.returns.rows[4].exit_net > 0, "final year carries the net reversion");
  assert.equal(r.sensitivity_table[0].value, 7037064);
  assert.equal(r.sensitivity_table.length, 5);
});

test("16-field pipe comp parser handles the documented example line", () => {
  const [c] = parseCompLines("830 Dean Street | Sold | 11/02/2025 | 9800000 | - | 31500 | 8200 | 1948 | Walk-Up | Multi | 100 | Investment | All Cash | 1187-22 | 6400000 | 2100000", 31);
  assert.equal(c.address, "830 Dean Street");
  assert.equal(c.status, "Sold");
  assert.equal(c.price, 9800000);
  assert.equal(c.sf, 31500);
  assert.equal(c.ppsf, 311);
  assert.equal(c.assessed_total, 6400000);
});

test("document figure reader finds NOI / income / expenses / units / price", () => {
  const found = readFiguresFromText("Gross Income: $612,500  Total Operating Expenses: $228,400  Net Operating Income $384,100  8 units total  Asking Price $6,400,000");
  assert.equal(found.noi, 384100);
  assert.equal(found.grossIncome, 612500);
  assert.equal(found.operatingExpenses, 228400);
  assert.equal(found.units, 8);
  assert.equal(found.askingPrice, 6400000);
});

test("document snapshots: OM / BOV / Deck carry their fixed sections", () => {
  const deal = { ...FIXED_DEAL, name: "272 East 3 Street", property: { ...FIXED_DEAL.property, address: "272 East 3 Street", bbl: "1003720009" }, brand: {}, comps: [], market: {} };
  const om = generateDealDoc(deal, "om");
  for (const s of ["Offering Memorandum", "Property Overview", "Investment Highlights", "Financial Analysis", "Cap-Rate Sensitivity", "Confidentiality & Disclaimer"]) {
    assert.ok(om.includes(s), `OM missing section: ${s}`);
  }
  const bov = generateDealDoc(deal, "bov");
  for (const s of ["Broker Opinion<br>of Value", "Confidentiality &amp; Agreement", "Executive Summary", "Broker Opinion of Value", "Assumptions &amp; Limiting Conditions", "No comparables were entered"]) {
    assert.ok(bov.includes(s), `BOV missing section: ${s}`);
  }
  const deck = generateDealDoc(deal, "deck");
  assert.ok(deck.includes("The Numbers") && deck.includes("Next Steps"), "Deck missing slides");
});
