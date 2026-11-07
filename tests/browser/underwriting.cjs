// Phase 17 — the calculator's arithmetic, checked against an independent model.
//
//   node tests/browser/underwriting.cjs [baseUrl]
//
// P17.2–P17.10 require validation "against independently computed values …
// using a fixed input set, with tolerance stated". So the finance below is
// implemented here from first principles — it does not read, import or mirror
// anything from the application — and then compared against what the shipped
// calculator renders for the same inputs.
//
// TOLERANCE, and why it is what it is.
// The UI rounds before it paints: percentages to two decimals, dollars to the
// whole unit, multiples to two decimals. A rendered "6.01%" therefore stands for
// any value in [6.005%, 6.015%), and demanding closer agreement than that would
// be testing the renderer, not the model. Tolerance is accordingly half the
// display step for each metric — 0.005 percentage points, $1, 0.005× — and is
// applied to the *displayed* figure. Anything looser would let a real error hide;
// anything tighter cannot be observed through the DOM.
//
// The input set is fixed and stated up front, so the expected values below are
// not chosen after seeing the output:
//
//   asking price          $6,400,000
//   building SF               18,500
//   units                         24
//   gross income (annual)   $612,500
//   operating expenses      $228,000
//   LTV                          65 %
//   rate                        6.5 %
//   amortisation             30 years
//   exit cap                    5.5 %
//   hold                       5 years
//
// Vacancy and NOI growth are left at the form's defaults and read back from the
// page, so the model uses the same figures the application does rather than
// assuming zero.
const { chromium } = require("playwright");
const { signIn } = require("./lib/gate.cjs");

const BASE = process.argv[2] || "http://localhost:5175";
const pinned = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const launchOptions = {
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  ...(require("node:fs").existsSync(pinned) ? { executablePath: pinned } : {})
};

const INPUTS = {
  "Asking price": 6400000,
  "Building SF": 18500,
  "Units / keys": 24,
  "Gross income (annual)": 612500,
  "Operating expenses (annual)": 228000,
  "LTV": 65,
  "Rate": 6.5,
  "Amortization": 30,
  "Exit cap": 5.5,
  "Hold": 5
};

// ---------------------------------------------------------------- the model
// Standard direct-capitalisation underwriting. Written out longhand rather than
// pulled from a library so the arithmetic under test is visible in the file.

// Level-payment mortgage constant, monthly compounding.
function monthlyPayment(principal, annualRatePct, years) {
  const i = annualRatePct / 100 / 12;
  const n = years * 12;
  if (i === 0) return principal / n;
  return (principal * i) / (1 - Math.pow(1 + i, -n));
}

// Remaining principal after `monthsPaid` payments.
function balanceAfter(principal, annualRatePct, years, monthsPaid) {
  const i = annualRatePct / 100 / 12;
  const n = years * 12;
  if (i === 0) return principal * (1 - monthsPaid / n);
  const pmt = monthlyPayment(principal, annualRatePct, years);
  return principal * Math.pow(1 + i, monthsPaid) - pmt * ((Math.pow(1 + i, monthsPaid) - 1) / i);
}

// IRR by bisection — slower than Newton and far harder to get wrong.
function irr(cashflows) {
  const npv = (r) => cashflows.reduce((s, cf, t) => s + cf / Math.pow(1 + r, t), 0);
  let lo = -0.9999, hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let k = 0; k < 300; k++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

function model({ price, sf, units, gross, opex, ltvPct, ratePct, amortYears, exitCapPct, holdYears, vacancyPct, growthPct }) {
  const egi = gross * (1 - vacancyPct / 100);
  const noi = egi - opex;
  const loan = price * (ltvPct / 100);
  const equity = price - loan;
  const debtService = monthlyPayment(loan, ratePct, amortYears) * 12;

  const noiAt = (year) => noi * Math.pow(1 + growthPct / 100, year - 1);
  const flows = [-equity];
  for (let t = 1; t <= holdYears; t++) flows.push(noiAt(t) - debtService);

  // Exit on the following year's NOI — the buyer capitalises forward income.
  const exitValue = noiAt(holdYears + 1) / (exitCapPct / 100);
  const payoff = balanceAfter(loan, ratePct, amortYears, holdYears * 12);
  const netProceeds = exitValue - payoff;
  flows[flows.length - 1] += netProceeds;

  const distributions = flows.slice(1).reduce((a, b) => a + b, 0);
  return {
    noi,
    capPct: (noi / price) * 100,
    grm: price / gross,
    pricePerUnit: price / units,
    pricePerSf: price / sf,
    loan,
    equity,
    debtService,
    dscr: noi / debtService,
    cocPct: ((noiAt(1) - debtService) / equity) * 100,
    exitValue,
    payoff,
    netProceeds,
    irrPct: irr(flows) * 100,
    equityMultiple: distributions / equity
  };
}

// ---------------------------------------------------------------- harness
const failures = [];
const results = [];
const check = (label, expected, actual, tol, unit) => {
  const ok = actual !== null && Math.abs(expected - actual) <= tol;
  const fmt = (v) => v === null ? "—" : unit === "$" ? `$${Math.round(v).toLocaleString()}` : unit === "%" ? `${v.toFixed(2)}%` : `${v.toFixed(2)}${unit}`;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label.padEnd(34)} model ${fmt(expected).padStart(12)}   app ${fmt(actual).padStart(12)}   ±${tol}${unit === "$" ? "" : unit}`);
  results.push({ label, expected, actual, ok });
  if (!ok) failures.push(`${label}: model ${fmt(expected)} vs app ${fmt(actual)} (tolerance ${tol})`);
};

const num = (text, re) => {
  const m = text.match(re);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/[$,×%\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

(async () => {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  // Every suite goes through the gate. Six of eight never did, and passed only
  // because the harness left the gate disabled — i.e. they were exercising a
  // server configuration that is never deployed.
  await signIn(context, BASE);
  const page = await context.newPage();

  await page.goto(`${BASE}/?p17=1#/calculator`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => /upload rent roll/i.test(document.body.innerText || ""), { timeout: 45000 });
  await page.waitForTimeout(1500);

  const filled = await page.evaluate((want) => {
    const set = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const done = [];
    for (const label of document.querySelectorAll("label")) {
      const text = (label.textContent || "").trim().replace(/[$%]|yrs$/g, "").trim();
      const key = Object.keys(want).find((k) => text.startsWith(k));
      if (!key) continue;
      const input = label.querySelector("input") || label.parentElement?.querySelector("input");
      if (input && input.type !== "checkbox" && input.type !== "file") { set(input, String(want[key])); done.push(key); }
    }
    return done;
  }, INPUTS);

  if (filled.length < Object.keys(INPUTS).length) {
    console.error(`only ${filled.length}/${Object.keys(INPUTS).length} inputs were set: ${filled.join(", ")}`);
    process.exit(1);
  }
  await page.waitForTimeout(3000);

  // Read the assumptions the form is actually carrying rather than assuming
  // them, so the model is fed the same numbers the application used.
  const assumptions = await page.evaluate(() => {
    const read = (name) => {
      for (const label of document.querySelectorAll("label")) {
        const text = (label.textContent || "").trim().replace(/[$%]|yrs$/g, "").trim();
        if (!text.startsWith(name)) continue;
        const input = label.querySelector("input") || label.parentElement?.querySelector("input");
        if (input) return parseFloat(input.value) || 0;
      }
      return 0;
    };
    return { vacancyPct: read("Vacancy"), growthPct: read("NOI growth / yr") };
  });

  const expected = model({
    price: INPUTS["Asking price"], sf: INPUTS["Building SF"], units: INPUTS["Units / keys"],
    gross: INPUTS["Gross income (annual)"], opex: INPUTS["Operating expenses (annual)"],
    ltvPct: INPUTS["LTV"], ratePct: INPUTS["Rate"], amortYears: INPUTS["Amortization"],
    exitCapPct: INPUTS["Exit cap"], holdYears: INPUTS["Hold"],
    vacancyPct: assumptions.vacancyPct, growthPct: assumptions.growthPct
  });

  const text = await page.evaluate(() => document.body.innerText || "");
  const app = {
    noi: num(text, /NOI \(annual\)\s*\$?([\d,]+)/i),
    capPct: num(text, /Cap rate[^\n]*\n\s*([\d.]+)%/i),
    grm: num(text, /GRM[^\n]*\n\s*([\d.]+)×/i),
    pricePerUnit: num(text, /Price \/ unit\s*\$?([\d,]+)/i),
    pricePerSf: num(text, /Price \/ SF\s*\$?([\d,]+)/i),
    dscr: num(text, /DSCR[^\n]*\n\s*([\d.]+)×/i),
    cocPct: num(text, /Cash-on-cash \(yr 1\)[^\n]*\n\s*([\d.]+)%/i),
    equity: num(text, /Equity in\s*\$?([\d,]+)/i),
    irrPct: num(text, /Levered IRR[^\n]*\n\s*([\d.]+)%/i),
    equityMultiple: num(text, /Equity multiple[^\n]*\n\s*([\d.]+)×/i)
  };

  console.log(`\nPhase 17 — independent model vs the shipped calculator`);
  console.log(`inputs: $${INPUTS["Asking price"].toLocaleString()} · ${INPUTS["Units / keys"]} units · ${INPUTS["Building SF"].toLocaleString()} SF · $${INPUTS["Gross income (annual)"].toLocaleString()} gross · $${INPUTS["Operating expenses (annual)"].toLocaleString()} opex`);
  console.log(`        ${INPUTS["LTV"]}% LTV · ${INPUTS["Rate"]}% · ${INPUTS["Amortization"]}yr amort · ${INPUTS["Exit cap"]}% exit cap · ${INPUTS["Hold"]}yr hold`);
  console.log(`form assumptions read back: vacancy ${assumptions.vacancyPct}% · NOI growth ${assumptions.growthPct}%\n`);

  // P17.1 standard underwriting
  check("P17.1  NOI (annual)", expected.noi, app.noi, 1, "$");
  check("P17.1  cap rate", expected.capPct, app.capPct, 0.005, "%");
  check("P17.1  GRM", expected.grm, app.grm, 0.005, "×");
  check("P17.1  price / unit", expected.pricePerUnit, app.pricePerUnit, 1, "$");
  check("P17.1  price / SF", expected.pricePerSf, app.pricePerSf, 1, "$");
  // P17.2 debt
  check("P17.2  equity in (price − loan)", expected.equity, app.equity, 1, "$");
  // P17.3 DSCR — the debt constant is the part a wrong amortisation would break
  check("P17.3  DSCR", expected.dscr, app.dscr, 0.005, "×");
  // P17.4 cash-on-cash
  check("P17.4  cash-on-cash (yr 1)", expected.cocPct, app.cocPct, 0.005, "%");
  // P17.5 / P17.6 — the multi-period metrics
  check("P17.5  levered IRR", expected.irrPct, app.irrPct, 0.005, "%");
  check("P17.6  equity multiple", expected.equityMultiple, app.equityMultiple, 0.005, "×");

  console.log(`\nintermediate values the model used (not rendered by the app, shown for audit):`);
  console.log(`  loan $${Math.round(expected.loan).toLocaleString()} · annual debt service $${Math.round(expected.debtService).toLocaleString()}`);
  console.log(`  exit value $${Math.round(expected.exitValue).toLocaleString()} · payoff at ${INPUTS.Hold}yr $${Math.round(expected.payoff).toLocaleString()} · net proceeds $${Math.round(expected.netProceeds).toLocaleString()}`);

  await browser.close();

  console.log(`\n${"=".repeat(64)}`);
  if (failures.length) {
    console.log(`UNDERWRITING: ${failures.length} of ${results.length} metrics disagree with the independent model`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log(`UNDERWRITING: PASS — ${results.length} metrics agree with an independently computed model within the display tolerance.`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
