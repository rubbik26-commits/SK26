// Deal Calculator engine — full port of the original underwriting math:
// income metrics, debt service, levered IRR with amortized balloon,
// sensitivity grid, equity waterfall, and residual-land development mode.

export const ASSET_CLASSES = [
  { key: "multifamily", label: "Multifamily" }, { key: "office", label: "Office" },
  { key: "retail", label: "Retail / Net Lease" }, { key: "industrial", label: "Industrial" },
  { key: "hotel", label: "Hotel" }, { key: "development", label: "Development" }
];
const OPEX_DEFAULT = { multifamily: 0.42, office: 0.45, retail: 0.3, industrial: 0.2, hotel: 0.68, development: 0 };

const n_ = (v) => (v == null || v === "" || isNaN(Number(v)) ? undefined : Number(v));
export const fUsd = (v) => (v == null || !isFinite(v) ? "—" : "$" + Math.round(v).toLocaleString());
export const fPct = (v) => (v == null || !isFinite(v) ? "—" : (v * 100).toFixed(2) + "%");
export const fX = (v) => (v == null || !isFinite(v) ? "—" : v.toFixed(2) + "×");

function annualDebtConstant(ratePct, amortYears) {
  const r = n_(ratePct), a = n_(amortYears);
  if (r == null || a == null || a <= 0) return undefined;
  const i = r / 100 / 12, n = a * 12;
  return i === 0 ? 12 / n : (i / (1 - Math.pow(1 + i, -n))) * 12;
}
function loanBalance(principal, ratePct, amortYears, afterYears) {
  const i = ratePct / 100 / 12, n = amortYears * 12, k = Math.min(afterYears * 12, n);
  if (i === 0) return principal * (1 - k / n);
  const pmt = principal * (i / (1 - Math.pow(1 + i, -n)));
  return principal * Math.pow(1 + i, k) - pmt * ((Math.pow(1 + i, k) - 1) / i);
}
function irr(cashflows) {
  if (cashflows.length < 2 || cashflows[0] >= 0) return undefined;
  const npv = (r) => cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
  let lo = -0.9, hi = 1.5, flo = npv(lo), fhi = npv(hi);
  if (flo * fhi > 0) return undefined;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

export function deriveNOI(inputs) {
  if (n_(inputs.noi) != null) return n_(inputs.noi);
  let gross = n_(inputs.grossIncome);
  if (gross == null && inputs.assetClass === "hotel" && n_(inputs.adr) != null && n_(inputs.occupancyPct) != null && n_(inputs.units) != null) {
    gross = n_(inputs.adr) * (n_(inputs.occupancyPct) / 100) * 365 * n_(inputs.units);
  }
  if (gross == null) return undefined;
  const egi = gross * (1 - (n_(inputs.vacancyPct) ?? 0) / 100);
  const opex = n_(inputs.operatingExpenses) ?? egi * OPEX_DEFAULT[inputs.assetClass];
  return egi - opex;
}

export function underwrite(inputs) {
  if (inputs.assetClass === "development") return underwriteDevelopment(inputs);
  const metrics = [], gaps = [];
  const price = n_(inputs.askingPrice);
  let noi = deriveNOI(inputs);
  const bsf = n_(inputs.buildingSf), units = n_(inputs.units);
  const reserves = n_(inputs.reservesPerUnit) != null && units != null ? n_(inputs.reservesPerUnit) * units : undefined;
  if (reserves != null && noi != null) noi -= reserves;
  if (noi == null) gaps.push("in-place income or NOI (rent roll / T12)");
  if (n_(inputs.noi) == null && n_(inputs.operatingExpenses) == null && n_(inputs.grossIncome) != null) gaps.push(`actual OpEx — using ${Math.round(OPEX_DEFAULT[inputs.assetClass] * 100)}% estimate`);
  if (reserves == null && noi != null) gaps.push("replacement reserves ($/unit)");
  if (price == null) gaps.push("asking price");
  if (n_(inputs.ltvPct) == null) gaps.push("LTV + rate (for DSCR / cash-on-cash / IRR)");
  if (n_(inputs.exitCapPct) == null || n_(inputs.holdYears) == null) gaps.push("exit cap + hold (for IRR / equity multiple)");
  if (n_(inputs.acqCostPct) == null) gaps.push("acquisition costs % (closing / DD)");
  if (n_(inputs.exitCostPct) == null) gaps.push("exit / selling costs %");

  if (noi != null) metrics.push({ label: "NOI (annual)", value: fUsd(noi) });
  if (noi != null && price) {
    const cap = noi / price;
    metrics.push({ label: "Cap rate", value: fPct(cap), flag: cap >= 0.06 ? "good" : cap >= 0.045 ? "watch" : "bad", note: "NOI ÷ price" });
  }
  if (price && n_(inputs.grossIncome)) metrics.push({ label: "GRM", value: fX(price / n_(inputs.grossIncome)), note: "price ÷ gross income" });
  if (price && units) metrics.push({ label: "Price / unit", value: fUsd(price / units) });
  if (price && bsf) metrics.push({ label: "Price / SF", value: fUsd(price / bsf) });
  if (inputs.assetClass === "hotel" && n_(inputs.adr) != null && n_(inputs.occupancyPct) != null) {
    metrics.push({ label: "RevPAR", value: fUsd(n_(inputs.adr) * (n_(inputs.occupancyPct) / 100)), note: "ADR × occupancy" });
  }

  const ltv = n_(inputs.ltvPct);
  const constant = annualDebtConstant(inputs.ratePct, inputs.amortYears);
  let equity, debtService, loan, cashflows;
  if (price && ltv != null) {
    loan = price * (ltv / 100);
    equity = price - loan + price * ((n_(inputs.acqCostPct) ?? 0) / 100) + (n_(inputs.capexBudget) ?? 0);
  }
  if (loan != null) debtService = inputs.interestOnly ? loan * ((n_(inputs.ratePct) ?? 0) / 100) : constant != null ? loan * constant : undefined;
  if (reserves != null) metrics.push({ label: "Reserves (annual)", value: fUsd(reserves), note: "deducted from NOI" });
  if (n_(inputs.capexBudget) != null) metrics.push({ label: "Capex / reno budget", value: fUsd(n_(inputs.capexBudget)), note: "added to equity" });
  if (noi != null && debtService != null && debtService > 0) {
    const dscr = noi / debtService;
    metrics.push({ label: "DSCR", value: fX(dscr), flag: dscr >= 1.25 ? "good" : dscr >= 1.1 ? "watch" : "bad", note: "lenders want 1.20–1.35×" });
  }
  if (noi != null && equity != null && equity > 0) {
    const coc = (noi - (debtService ?? 0)) / equity;
    metrics.push({ label: "Cash-on-cash (yr 1)", value: fPct(coc), flag: coc >= 0.08 ? "good" : coc >= 0.05 ? "watch" : "bad", note: "core 5–8% · value-add 8–12%" });
    metrics.push({ label: "Equity in", value: fUsd(equity) });
  }
  const hold = n_(inputs.holdYears), exitCap = n_(inputs.exitCapPct);
  const growth = (n_(inputs.noiGrowthPct) ?? 0) / 100;
  if (noi != null && equity != null && equity > 0 && hold && exitCap) {
    const cf = [-equity];
    for (let y = 1; y <= hold; y++) {
      const yearCF = noi * Math.pow(1 + growth, y - 1) - (debtService ?? 0);
      if (y === hold) {
        const gross = (noi * Math.pow(1 + growth, hold)) / (exitCap / 100) * (1 - (n_(inputs.exitCostPct) ?? 0) / 100);
        const balloon = inputs.interestOnly ? loan ?? 0 : loan != null && n_(inputs.ratePct) != null && n_(inputs.amortYears) != null ? loanBalance(loan, n_(inputs.ratePct), n_(inputs.amortYears), hold) : loan ?? 0;
        cf.push(yearCF + (gross - balloon));
      } else cf.push(yearCF);
    }
    cashflows = cf;
    const totalOut = cf.slice(1).reduce((a, b) => a + b, 0);
    const em = totalOut / equity;
    const r = irr(cf);
    if (r != null) metrics.push({ label: "Levered IRR", value: fPct(r), flag: r >= 0.15 ? "good" : r >= 0.1 ? "watch" : "bad", note: `${hold}-yr hold · exit ${exitCap}% cap` });
    metrics.push({ label: "Equity multiple", value: fX(em), note: "total cash ÷ equity in" });
  }
  const capNow = noi != null && price ? noi / price : undefined;
  const summary = noi != null && price
    ? `At ${fUsd(price)} the deal pencils to a ${fPct(capNow)} cap on ${fUsd(noi)} NOI${capNow != null ? (capNow >= 0.06 ? " — at/above a healthy yield." : " — yield is tight; push price or income.") : "."}`
    : "Enter price and income (or NOI) to underwrite — quick math runs with just those two.";
  return { metrics, noi, summary, gaps, equity, cashflows };
}

export function sensitivityGrid(inputs) {
  const cap = n_(inputs.exitCapPct);
  if (inputs.assetClass === "development" || cap == null || n_(inputs.askingPrice) == null) return null;
  const caps = [cap - 0.5, cap - 0.25, cap, cap + 0.25, cap + 0.5].map((c) => Math.round(c * 100) / 100);
  const growths = [0, 2, 3, 4];
  const grid = growths.map((g) =>
    caps.map((c) => {
      const m = underwrite({ ...inputs, exitCapPct: c, noiGrowthPct: g }).metrics.find((x) => x.label === "Levered IRR");
      if (!m) return null;
      const v = parseFloat(m.value);
      return isFinite(v) ? v : null;
    })
  );
  return { exitCaps: caps, growths, grid };
}

export function waterfall(equity, cashflows, prefPct = 8, promotePct = 20) {
  if (equity == null || equity <= 0 || !cashflows || cashflows.length < 2) return null;
  const totalIn = cashflows.slice(1).reduce((a, b) => a + Math.max(0, b), 0);
  const profit = totalIn - equity;
  if (profit <= 0) return { lp: totalIn, gp: 0, lpMultiple: totalIn / equity, pref: 0, profit: Math.max(0, profit) };
  const years = cashflows.length - 1;
  const pref = equity * (Math.pow(1 + prefPct / 100, years) - 1);
  const abovePref = Math.max(0, profit - pref);
  const promote = abovePref * (promotePct / 100);
  const lp = equity + Math.min(profit, pref) + (abovePref - promote);
  return { lp: Math.round(lp), gp: Math.round(promote), lpMultiple: Math.round((lp / equity) * 100) / 100, pref: Math.round(pref), profit: Math.round(profit) };
}

function underwriteDevelopment(inputs) {
  const metrics = [], gaps = [];
  const bsf = n_(inputs.buildableSf), gdv = n_(inputs.gdv), hard = n_(inputs.hardCostPerSf);
  const softPct = (n_(inputs.softCostPct) ?? 0) / 100;
  const target = (n_(inputs.targetProfitPct) ?? 15) / 100;
  const land = n_(inputs.landPrice);
  if (bsf == null) gaps.push("buildable SF (max FAR × lot − built)");
  if (hard == null) gaps.push("hard cost $/SF");
  if (n_(inputs.softCostPct) == null) gaps.push("soft cost % (using 0)");
  if (gdv == null) gaps.push("gross development value (GDV)");
  if (land == null) gaps.push("land asking price (to test the deal)");
  if (n_(inputs.exitCapPct) == null) gaps.push("exit cap (for yield-on-cost spread)");
  const hardTotal = bsf != null && hard != null ? bsf * hard : undefined;
  const soft = hardTotal != null ? hardTotal * softPct : undefined;
  const build = hardTotal != null ? hardTotal + (soft ?? 0) : undefined;
  if (build != null) metrics.push({ label: "Construction cost", value: fUsd(build), note: `hard ${fUsd(hardTotal)} + soft ${fPct(softPct)}` });
  if (gdv != null && build != null) {
    const profitReq = gdv * target;
    const rlv = gdv - build - profitReq;
    metrics.push({ label: "Residual land value", value: fUsd(rlv), flag: land != null ? (rlv >= land ? "good" : "bad") : undefined, note: `max land pay at ${fPct(target)} profit${land != null ? ` · asking ${fUsd(land)}` : ""}` });
    const cost = build + (land ?? 0);
    if (land != null) {
      const margin = gdv / cost - 1;
      metrics.push({ label: "Profit margin on cost", value: fPct(margin), flag: margin >= 0.15 ? "good" : margin >= 0.1 ? "watch" : "bad", note: "target 15–25%" });
    }
    if (bsf) metrics.push({ label: "GDV / buildable SF", value: fUsd(gdv / bsf) });
  }
  const noi = deriveNOI(inputs);
  const totalCost = (build ?? 0) + (land ?? 0);
  if (noi != null && totalCost > 0) {
    const yoc = noi / totalCost;
    metrics.push({ label: "Yield on cost", value: fPct(yoc), flag: yoc >= 0.065 ? "good" : yoc >= 0.05 ? "watch" : "bad", note: "stabilized NOI ÷ total cost (going-in)" });
    const exitCap = n_(inputs.exitCapPct);
    if (exitCap) {
      const spread = yoc - exitCap / 100;
      metrics.push({ label: "Development spread", value: (spread * 1e4).toFixed(0) + " bps", flag: spread >= 0.015 ? "good" : spread >= 0.01 ? "watch" : "bad", note: "yield-on-cost over exit cap (want 150+ bps)" });
    }
  }
  const summary = gdv != null && build != null
    ? `RLV says you can pay up to ${fUsd(gdv - build - gdv * target)} for the land to hit a ${fPct(target)} profit.`
    : "Enter buildable SF, hard $/SF, soft %, GDV and target profit to size the land.";
  return { metrics, noi, summary, gaps };
}

// Plain-English deal parsing ("asking 5m, 70 LTV, 6.5 rate, 5.5 exit, 5yr hold")
function scaled(text) {
  const m = text.match(/([\d,.]+)\s*(m|mm|million|k|thousand|bn|b)?/i);
  if (!m) return undefined;
  let v = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(v)) return undefined;
  const suf = (m[2] || "").toLowerCase();
  if (suf.startsWith("m")) v *= 1e6;
  else if (suf === "k" || suf === "thousand") v *= 1e3;
  else if (suf.startsWith("b")) v *= 1e9;
  return v;
}
export function parsePlainEnglish(text) {
  const t = " " + text.toLowerCase().replace(/\$/g, " $") + " ";
  const grab = (re) => { const m = t.match(re); return m ? m[1] : undefined; };
  const inputs = {};
  let assetClass;
  if (/\b(multifamily|apartment|residential|mf)\b/.test(t)) assetClass = "multifamily";
  else if (/\boffice\b/.test(t)) assetClass = "office";
  else if (/\b(retail|net lease|nnn|store)\b/.test(t)) assetClass = "retail";
  else if (/\b(industrial|warehouse|logistics)\b/.test(t)) assetClass = "industrial";
  else if (/\b(hotel|hospitality|lodging)\b/.test(t)) assetClass = "hotel";
  else if (/\b(development|dev site|land|ground up|ground-up)\b/.test(t)) assetClass = "development";
  const price = grab(/(?:asking|price|buy(?:ing)?|offer(?:ed)?(?:\s*at)?|purchase|at)\s*\$?\s*([\d,.]+\s*(?:m|mm|million|k|thousand|b|bn)?)/);
  if (price) { const v = scaled(price); if (v && v > 1e3) inputs.askingPrice = v; }
  const noi = grab(/noi\s*(?:of|is|=)?\s*\$?\s*([\d,.]+\s*(?:m|mm|million|k|thousand)?)/);
  if (noi) inputs.noi = scaled(noi);
  const ltv = grab(/([\d.]+)\s*%?\s*(?:ltv|loan[-\s]?to[-\s]?value|leverage)/) || grab(/(?:ltv|leverage)\s*(?:of|at|=)?\s*([\d.]+)/);
  if (ltv) inputs.ltvPct = parseFloat(ltv);
  const rate = grab(/([\d.]+)\s*%?\s*(?:rate|interest|coupon)/) || grab(/(?:rate|interest)\s*(?:of|at|=)?\s*([\d.]+)/);
  if (rate) inputs.ratePct = parseFloat(rate);
  const exit = grab(/([\d.]+)\s*%?\s*(?:exit\s*cap|exit|reversion|terminal\s*cap|going[-\s]?out)/) || grab(/exit\s*(?:cap)?\s*(?:of|at|=)?\s*([\d.]+)/);
  if (exit) inputs.exitCapPct = parseFloat(exit);
  const hold = grab(/([\d.]+)\s*(?:year|yr)s?\s*(?:hold|holding)?/);
  if (hold) inputs.holdYears = parseFloat(hold);
  const units = grab(/([\d,]+)\s*(?:units|keys|doors|apartments)/);
  if (units) inputs.units = parseFloat(units.replace(/,/g, ""));
  const vac = grab(/([\d.]+)\s*%?\s*vacancy/);
  if (vac) inputs.vacancyPct = parseFloat(vac);
  return { inputs, assetClass };
}
