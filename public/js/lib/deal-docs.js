// Deal documents — the branded client-ready set generated from the Deal
// Calculator: Offering Memorandum and Deck (gallery style, navy + gold) and
// the Broker Opinion of Value book (navy + orange, framed pages).
//
// The engine is deliberately self-contained: every helper it needs lives in
// this file so a document can never break because a page module changed.

// ---------------------------------------------------------------- formatting
const esc = (v) => (v == null ? "" : String(v)).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const parseNum = (v) => {
  if (typeof v === "number") return isFinite(v) ? v : null;
  const n = parseFloat(String(v ?? "").replace(/[$,%\s,]/g, ""));
  return isFinite(n) ? n : null;
};
const posNum = (v) => { const n = parseNum(v); return n != null && n > 0 ? n : null; };
const roundTo = (v, d) => (v == null ? null : Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0));
const money = (v) => (v == null ? "—" : "$" + Math.round(v).toLocaleString());
const pctFmt = (v, d) => (v == null ? "—" : (v * 100).toFixed(d ?? 2) + "%");
const numFmt = (v) => (v == null ? "—" : Number(v).toLocaleString());

// Aerial imagery for covers and map panels — proxied Esri World Imagery.
const staticImg = (lat, lng, span, w, h) =>
  `/api/staticmap?lat=${lat}&lng=${lng}&span=${span || 0.0016}&size=${w || 1200}x${h || 750}`;

// ------------------------------------------------------------------- finance
function monthlyPayment(amount, rate, amortYears) {
  amount = posNum(amount); amortYears = posNum(amortYears); rate = parseNum(rate);
  if (amount == null || amortYears == null || rate == null || rate < 0) return null;
  if (rate === 0) return amount / (amortYears * 12);
  const r = rate / 12, n = amortYears * 12;
  return (amount * r) / (1 - Math.pow(1 + r, -n));
}

function irrBisect(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;
  const npv = (r) => cashflows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + r, i), 0);
  if (!(npv(0) > 0)) return null;
  let lo = -0.9999, hi = 10, mid = 0;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const v = npv(mid);
    if (Math.abs(v) < 1e-6) break;
    if (v > 0) lo = mid; else hi = mid;
  }
  return mid;
}

function buildReturns(o) {
  const price = posNum(o.price), hold = posNum(o.holdYears), exitCap = posNum(o.exitCap);
  if (price == null || hold == null || exitCap == null || parseNum(o.noiYear1) == null) return null;
  const equity = price - (parseNum(o.loanAmount) || 0);
  if (!(equity > 0)) return null;
  const pmt = monthlyPayment(o.loanAmount, o.loanRate, o.loanAmortYears);
  const annualDs = pmt == null ? 0 : pmt * 12;
  let bal = parseNum(o.loanAmount) || 0;
  const mRate = (parseNum(o.loanRate) || 0) / 12;
  const cashflows = [-equity], rows = [];
  let cocSum = 0;
  const growth = parseNum(o.noiGrowth) || 0;
  for (let y = 1; y <= hold; y++) {
    const noi = o.noiYear1 * Math.pow(1 + growth, y - 1);
    if (pmt != null && bal > 0) {
      for (let m = 0; m < 12 && bal > 0; m++) {
        const interest = bal * mRate;
        bal -= Math.min(pmt - interest, bal);
      }
    }
    const cf = noi - annualDs;
    const coc = equity > 0 ? cf / equity : null;
    cocSum += coc || 0;
    let flow = cf;
    if (y === hold) {
      const exitNoi = o.noiYear1 * Math.pow(1 + growth, hold);
      const gross = exitNoi / exitCap;
      const net = gross * (1 - (parseNum(o.exitCostPct) || 0));
      flow += net - bal;
      rows.push({ year: y, noi: roundTo(noi, 0), ds: roundTo(annualDs, 0), cf: roundTo(cf, 0), coc: roundTo(coc, 4), exit_net: roundTo(net, 0) });
    } else {
      rows.push({ year: y, noi: roundTo(noi, 0), ds: roundTo(annualDs, 0), cf: roundTo(cf, 0), coc: roundTo(coc, 4) });
    }
    cashflows.push(flow);
  }
  const totalIn = cashflows.slice(1).reduce((a, b) => a + b, 0);
  return {
    equity: roundTo(equity, 0), hold_years: hold, exit_cap: exitCap,
    irr: roundTo(irrBisect(cashflows), 4),
    equity_multiple: roundTo(totalIn / equity, 3),
    total_profit: roundTo(totalIn - equity, 0),
    avg_coc: roundTo(cocSum / hold, 4),
    rows
  };
}

function capSensitivity(noi, cap, units, sf) {
  noi = parseNum(noi); cap = posNum(cap);
  if (noi == null || cap == null) return null;
  const base = noi / cap, out = [];
  for (let bps = -50; bps <= 50; bps += 25) {
    const c = cap + bps / 1e4;
    if (c <= 0) continue;
    const v = noi / c;
    out.push({
      capLabel: (c * 100).toFixed(2) + "%", value: roundTo(v, 0),
      ppu: units ? roundTo(v / units, 0) : null, ppsf: sf ? roundTo(v / sf, 2) : null,
      deltaPct: roundTo(((v - base) / base) * 100, 2), isBase: bps === 0
    });
  }
  return out;
}

const normPct = (v) => {
  v = parseNum(v);
  if (v == null || v < 0) return 0;
  if (v > 1) v = v / 100;
  return v >= 1 ? 0.999 : v;
};

// Full underwriting rollup for a deal object: EGI/NOI, optional stabilized
// proforma, hold-period returns, DSCR and the cap-rate sensitivity strip.
export function financeRollup(deal) {
  const p = deal.property || {}, fin = deal.financials || {}, uw = deal.underwriting || {}, loan = uw.loan || {};
  const gpr = parseNum(fin.gross_income);
  const egi = gpr != null ? gpr * (1 - normPct(fin.vacancy_pct)) + (parseNum(fin.other_income) || 0) : null;
  const noi = egi != null && parseNum(fin.opex) != null ? egi - fin.opex : null;
  const price = parseNum(uw.asking_price);
  const cap = noi != null && price ? noi / price : null;
  let ds = monthlyPayment(loan.amount, loan.rate, loan.amort_years);
  ds = ds == null ? null : ds * 12;
  const pf = uw.proforma || {};
  let proforma = null;
  if (["market_gross_income", "rent_uplift_pct", "stabilized_vacancy_pct", "expense_growth_pct"].some((k) => parseNum(pf[k]) != null)) {
    const marketGpr = parseNum(pf.market_gross_income) != null ? pf.market_gross_income
      : parseNum(pf.rent_uplift_pct) != null && gpr != null ? gpr * (1 + pf.rent_uplift_pct) : gpr;
    if (marketGpr != null) {
      const stabEgi = marketGpr * (1 - normPct(pf.stabilized_vacancy_pct)) + (parseNum(pf.other_income) || 0);
      const stabOpex = parseNum(fin.opex) != null ? fin.opex * (1 + (parseNum(pf.expense_growth_pct) || 0)) : null;
      const stabNoi = stabEgi != null && stabOpex != null ? stabEgi - stabOpex : null;
      proforma = { gpr: roundTo(marketGpr, 0), egi: roundTo(stabEgi, 0), opex: roundTo(stabOpex, 0), noi: roundTo(stabNoi, 0), cap_rate: stabNoi != null && price ? roundTo(stabNoi / price, 6) : null };
    }
  }
  const noiForReturns = proforma?.noi ?? noi;
  const returns = parseNum(uw.exit_cap) != null && parseNum(uw.hold_years) != null
    ? buildReturns({
        price, noiYear1: noiForReturns, noiGrowth: parseNum(uw.noi_growth_pct) || 0,
        holdYears: uw.hold_years, exitCap: uw.exit_cap, exitCostPct: parseNum(uw.exit_cost_pct) || 0,
        loanAmount: loan.amount, loanRate: loan.rate, loanAmortYears: loan.amort_years
      })
    : null;
  return {
    gpr: roundTo(gpr, 0), egi: roundTo(egi, 0), noi: roundTo(noi, 0),
    proforma, returns, asking_price: price, cap_rate: roundTo(cap, 6),
    market_cap_rate: parseNum(uw.market_cap_rate),
    ppu: price && p.units ? roundTo(price / p.units, 0) : null,
    ppsf: price && p.sf ? roundTo(price / p.sf, 2) : null,
    dscr: noi != null && ds ? roundTo(noi / ds, 3) : null,
    loan_amount: parseNum(loan.amount), annual_debt_service: roundTo(ds, 0),
    sensitivity_table: capSensitivity(noi, cap || parseNum(uw.market_cap_rate), p.units, p.sf)
  };
}

// ------------------------------------------------------------- comp parsing
// One comp per line, pipe-separated:
// address | status | sale date | sale price | asking price | RBA sf | land sf
// | year built | bldg type | tenancy | % leased | sale type | financing
// | parcel no | assessed total | assessed land
export function parseCompLines(text, subjectUnits) {
  return String(text || "").split(/\n+/).map((line) => {
    if (!line.trim()) return null;
    const f = line.split("|").map((s) => s.trim());
    if (!f[0]) return null;
    const n = (i) => posNum(f[i]);
    const s = (i) => { const v = (f[i] || "").trim(); return v && v !== "-" ? v : null; };
    const st = (f[1] || "").toLowerCase();
    const c = {
      address: f[0],
      status: /contract|pend/.test(st) ? "Contract" : /sold|closed/.test(st) ? "Sold" : /active|list|avail/.test(st) ? "Active" : f[1] || "—",
      sale_date: s(2), price: n(3), ask_price: n(4), sf: n(5), land_sf: n(6),
      year_built: s(7), bldg_type: s(8), tenancy: s(9), leased_pct: parseNum(f[10]),
      sale_type: s(11), financing: s(12), parcel: s(13), assessed_total: n(14), assessed_land: n(15)
    };
    if (c.price == null && c.ask_price != null) c.price = c.ask_price;
    c.ppsf = c.price && c.sf ? roundTo(c.price / c.sf, 0) : null;
    c.ppac = c.price && c.land_sf ? roundTo(c.price / (c.land_sf / 43560), 0) : null;
    c.ppu = c.price && subjectUnits ? roundTo(c.price / subjectUnits, 0) : null;
    return c.price || c.ppsf ? c : null;
  }).filter(Boolean);
}

// -------------------------------------------------- reading figures from text
// Pulls NOI / income / expenses / units / asking price out of a pasted or
// uploaded text document (T-12 export, listing text, OM text).
export function readFiguresFromText(raw) {
  const text = String(raw || "").replace(/\s+/g, " ");
  const grab = (re) => { const m = text.match(re); return m ? parseNum(m[1]) : null; };
  const out = {};
  const noi = grab(/net operating income[^$\d]{0,25}\$?\s*([\d.,]+)/i);
  if (noi) out.noi = noi;
  const gross = grab(/(?:gross (?:potential )?(?:income|rent|revenue)|total (?:income|revenue|rental income))[^$\d]{0,25}\$?\s*([\d.,]+)/i);
  if (gross) out.grossIncome = gross;
  const opex = grab(/(?:total operating expenses|operating expenses|total expenses)[^$\d]{0,25}\$?\s*([\d.,]+)/i);
  if (opex) out.operatingExpenses = opex;
  const units = grab(/([\d,]+)\s*(?:units|apartments|keys|doors)\b/i);
  if (units && units < 1e5) out.units = units;
  const price = grab(/(?:asking price|offering price|list price|purchase price|offered at|price)[^$\d]{0,20}\$?\s*([\d.,]+)/i);
  if (price && price > 1e4) out.askingPrice = price;
  return out;
}

// ------------------------------------------------------------------ styling
const MTA_COLORS = {
  1: "#EE352E", 2: "#EE352E", 3: "#EE352E", 4: "#00933C", 5: "#00933C", 6: "#00933C",
  7: "#B933AD", A: "#0039A6", C: "#0039A6", E: "#0039A6", B: "#FF6319", D: "#FF6319",
  F: "#FF6319", M: "#FF6319", G: "#6CBE45", J: "#996633", Z: "#996633", L: "#A7A9AC",
  N: "#FCCC0A", Q: "#FCCC0A", R: "#FCCC0A", W: "#FCCC0A", S: "#808183"
};
const subwayBullet = (route) =>
  `<span class="gsub" style="background:${MTA_COLORS[route] || "#4A4A4A"};color:${["N", "Q", "R", "W"].includes(route) ? "#000" : "#fff"}">${esc(route)}</span>`;

const BOOK = { nv: "#101C2F", or: "#E4873C", ink: "#26313F", mut: "#7A8797" };
const compStatus = (s) => ({
  Active: { pin: "#E4873C", label: "Active" },
  Contract: { pin: "#C9721F", label: "Under Contract" },
  Sold: { pin: "#101C2F", label: "Sold" }
}[s] || { pin: "#8A93A0", label: String(s || "—") });

function galleryCss(nv, tn) {
  return `<style>@import url("https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Inter:wght@400;600;700;800&display=swap");
.gdoc{--nv:${nv};--tn:${tn};max-width:850px;margin:0 auto;background:#fff;color:#1A2432;font-family:Inter,system-ui,sans-serif}
.gdoc .serif{font-family:"Playfair Display",Georgia,serif}
.gpg{position:relative;padding:56px 60px;overflow:hidden;background:#fff;page-break-inside:avoid}
.gpg+.gpg{border-top:1px solid #ECEFF3}.gcover,.gtoc{page-break-after:always}.gcover+.gpg,.gtoc+.gpg{border-top:0}
.gsec{font-size:13px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--nv);margin:0 0 6px}
.grule{height:3px;width:46px;background:var(--tn);margin:0 0 20px}
.gp{font-size:13.5px;line-height:1.65;color:#26313F;margin:0 0 14px}
.gfoot{position:absolute;left:60px;right:60px;bottom:26px;display:flex;justify-content:space-between;font-size:9.5px;letter-spacing:.04em;color:#8A97A6;border-top:1px solid #E3E8EE;padding-top:8px}
.gcover{padding:0;min-height:1100px;display:flex;flex-direction:column}
.gcover .hero{flex:1 1 62%;background-size:cover;background-position:center;position:relative;background-color:var(--nv)}
.gcover .band2{flex:0 0 38%;background:var(--nv);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:34px 40px;position:relative}
.gcover.nophoto .band2{flex:1 1 100%;justify-content:center;padding:0 64px}.gcover.nophoto h1{font-size:46px;max-width:660px}
.gcover.nophoto .crule{width:64px;height:2px;background:var(--tn);margin:26px auto 0}
.gcover .pin{position:absolute;left:50%;top:-52px;width:1px;height:52px;background:rgba(255,255,255,.6)}
.gcover .pin:after{content:"";position:absolute;left:-3px;bottom:-3px;width:7px;height:7px;border-radius:50%;background:#fff}
.gcover h1{font-family:"Playfair Display",Georgia,serif;font-size:40px;font-weight:600;margin:6px 0 6px;line-height:1.12}
.gcover .doctype{font-size:12px;letter-spacing:.30em;text-transform:uppercase;color:var(--tn);font-weight:700}
.gcover .sub{color:#C4CEDA;font-size:13.5px}
.gcover .cfoot{position:absolute;left:40px;right:40px;bottom:22px;display:flex;justify-content:space-between;font-size:11px;color:#9FB0C2}
.gtoc{padding:0;min-height:1100px;position:relative}
.gtoc .bg{position:absolute;inset:0;background-size:cover;background-position:center;background-color:var(--nv)}
.gtoc .panel{position:absolute;top:0;right:0;bottom:0;width:46%;background:var(--nv);color:#fff;padding:70px 48px;display:flex;flex-direction:column;justify-content:center;gap:34px}
.gtoc .ti .n{font-family:"Playfair Display",Georgia,serif;font-size:46px;font-weight:600;line-height:1}
.gtoc .ti .l{font-size:12.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;margin-top:4px;color:#C4CEDA}
.grail{background:var(--nv);color:#fff;border-radius:2px;padding:6px 22px}
.grail .r{padding:11px 0;border-bottom:1px solid rgba(255,255,255,.14);text-align:center}.grail .r:last-child{border-bottom:none}
.grail .v{font-family:"Playfair Display",Georgia,serif;font-size:20px;font-weight:600}
.grail .k{font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:#9FB0C2;margin-top:1px}
.gband{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #E3E8EE;border-radius:8px;overflow:hidden;margin:0 0 20px}
.gband .c{padding:14px 16px;border-right:1px solid #E3E8EE}.gband .c:last-child{border-right:none}
.gband .v{font-family:"Playfair Display",Georgia,serif;font-size:21px;font-weight:600}
.gband .k{font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:#7A8797}
.gt{width:100%;border-collapse:collapse;font-size:12.5px;margin:6px 0 18px}
.gt th{background:var(--nv);color:#fff;text-align:left;padding:8px 11px;font-size:10px;letter-spacing:.06em;text-transform:uppercase}
.gt td{padding:8px 11px;border-bottom:1px solid #E7ECF1}.gt tr.tot td{border-top:2px solid var(--nv);font-weight:700}
.gt td.r,.gt th.r{text-align:right}
.ghi{display:flex;gap:12px;align-items:flex-start;margin:0 0 14px}
.ghi .num{font-family:"Playfair Display",Georgia,serif;font-size:22px;font-weight:600;color:var(--tn);min-width:34px}
.ghi .txt{font-size:13px;line-height:1.55}.ghi .txt b{color:var(--nv)}
.gmapimg{width:100%;height:360px;object-fit:cover;border-radius:6px;border:1px solid #E3E8EE;margin:2px 0 10px}
.gsub{display:inline-flex;width:18px;height:18px;border-radius:50%;color:#fff;font-size:11px;font-weight:700;align-items:center;justify-content:center;margin-right:2px}
.gstation{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #E7ECF1;font-size:12.5px}
.gstation .w{margin-left:auto;color:#7A8797;font-size:11.5px}
.gdemo{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:10px 0 4px}
.gdemo .d{background:#F6F8FA;border:1px solid #E3E8EE;border-radius:8px;padding:12px 14px}
.gdemo .v{font-family:"Playfair Display",Georgia,serif;font-size:19px;font-weight:600;color:var(--nv)}
.gdemo .k{font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:#7A8797}
.gdisc{font-size:9.5px;line-height:1.55;color:#7A8797}
.twocol{column-count:2;column-gap:26px}.twocol .gp{margin-top:0;break-inside:avoid}
.reqbox{border:1px solid #E3C08A;background:#FDF7EC;border-left:4px solid #C97A16;border-radius:6px;padding:16px 18px;margin-top:8px}
.reqbox b{font-size:13px;color:#1B2430}.reqbox p{margin:8px 0 0;font-size:11.5px;line-height:1.65;color:#4A5563}
.reqbox .how{border-top:1px solid #EBDCC2;padding-top:10px;margin-top:12px}
.reqbox code{background:#fff;border:1px solid #E3E8EE;border-radius:3px;padding:2px 6px;font-size:10.5px;display:inline-block;margin-top:4px}
@media print{*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}.gpg{min-height:auto}@page{size:letter portrait;margin:0}}
</style>`;
}

function bookCss() {
  const { nv, or, ink, mut } = BOOK;
  return `<style>
.cma .bpg{background:#fff;color:${ink};padding:0;min-height:1100px;page-break-after:always;position:relative;display:flex;flex-direction:column}
.cma .bpg:last-child{page-break-after:auto}
.cma .bkey{position:absolute;left:16px;right:16px;top:16px;bottom:16px;border:1px solid ${or};pointer-events:none;z-index:2}
.cma .bbody{position:relative;z-index:1;padding:46px 46px 0;flex:1;display:flex;flex-direction:column}
.cma .bft{position:relative;z-index:3;margin-top:auto;background:${nv};color:#C4CEDA;display:flex;align-items:center;justify-content:flex-end;font-size:9.5px;letter-spacing:.03em;height:30px}
.cma .bft .t{padding-right:14px}.cma .bft .t b{color:${or};font-weight:600;letter-spacing:.08em}
.cma .bft .n{background:${or};color:${nv};font-weight:700;font-size:11px;min-width:34px;height:30px;display:flex;align-items:center;justify-content:center}
.cma .bh{color:${or};font-size:16px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin:0 0 16px}
.cma .bh span{opacity:.75;font-weight:400}
.cma .bp{font-size:12px;line-height:1.75;color:#3A4654;margin:0 0 12px}
.cma .bcov{position:relative;min-height:1100px;padding:0;display:flex;page-break-after:always;background:${nv}}
.cma .bcov .ph{position:absolute;inset:0;background-size:cover;background-position:center}
.cma .bcov .lt{position:relative;z-index:2;width:46%;background:linear-gradient(180deg,${nv} 0%,rgba(16,28,47,.94) 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 34px}
.cma .bcov h1{color:${or};font-size:26px;font-weight:700;letter-spacing:.02em;line-height:1.25;margin:0 0 14px;text-transform:uppercase}
.cma .bcov .ad{color:#E7EDF4;font-size:14px;line-height:1.55}
.cma .bcov .pb{position:absolute;bottom:64px;left:0;right:0;text-align:center;font-size:10.5px;line-height:1.6;color:#C4CEDA}
.cma .bcov .pb b{color:${or};display:block;font-size:9.5px;letter-spacing:.14em;margin-bottom:5px}
.cma .btoc .r{display:flex;align-items:baseline;gap:22px;padding:11px 0}
.cma .btoc .n{color:${or};font-size:26px;font-weight:700;min-width:52px}.cma .btoc .l{font-size:22px;color:#fff;font-weight:400}
.cma .bdiv{position:relative;min-height:1100px;page-break-after:always;background:${nv}}
.cma .bdiv .ph{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.5}
.cma .bdiv .pn{position:absolute;left:9%;right:9%;top:40%;background:rgba(16,28,47,.80);border:1px solid ${or};padding:32px 30px;text-align:center}
.cma .bdiv .pn h2{color:${or};font-size:30px;font-weight:400;letter-spacing:.06em;margin:0;text-transform:uppercase;line-height:1.3}
.cma .bstat{display:grid;grid-template-columns:1fr 1fr;gap:0 26px}
.cma .bsec{margin-bottom:16px}
.cma .bsec h4{text-align:center;font-size:12px;font-weight:700;color:${ink};letter-spacing:.04em;margin:0 0 10px;text-transform:uppercase}
.cma .bsec .rule{border-bottom:1px solid #D9DFE6;margin:0 0 12px}
.cma .bkf{display:flex;gap:14px;justify-content:space-around;text-align:center}
.cma .bkf .v{font-size:19px;color:${ink}}.cma .bkf .k{font-size:8px;letter-spacing:.07em;text-transform:uppercase;color:${mut};margin-top:3px;line-height:1.4}
.cma .bbar{display:flex;align-items:center;gap:8px;margin:5px 0;font-size:10px}
.cma .bbar .t{width:80px;color:${mut};text-align:right;font-size:9px}
.cma .bbar .tr{flex:1;height:8px;background:#E7EBF0}.cma .bbar .fl{height:8px;background:${or}}
.cma .bbar .p{width:34px;font-size:9.5px;color:${ink}}
.cma .bcg{display:grid;grid-template-columns:1fr 1fr;gap:20px;flex:1;align-content:stretch}
.cma .bcard{display:flex;flex-direction:column}
.cma .bcard .im{position:relative;height:210px;background:#E7EBF0 center/cover no-repeat;border:1px solid ${or}}
.cma .bcard .cap{display:flex;align-items:stretch;background:${nv};color:#fff;font-size:10px}
.cma .bcard .cap .n{background:${or};color:${nv};font-weight:700;padding:0 9px;display:flex;align-items:center}
.cma .bcard .cap .a{flex:1;padding:8px 9px;letter-spacing:.02em}
.cma .bcard .cap .s{background:${or};color:${nv};font-weight:700;padding:8px 10px;letter-spacing:.06em;display:flex;align-items:center}
.cma .bkv{margin-top:10px}
.cma .bkv .r{display:flex;justify-content:space-between;gap:10px;font-size:10.5px;padding:9px 3px;border-bottom:1px solid #ECEFF3}
.cma .bkv .r .k{color:${ink}}.cma .bkv .r .v{color:#4A5563;text-align:right;white-space:nowrap}
.cma .bam{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:14px}
.cma .bam .hd{background:${or};color:${nv};font-size:9.5px;font-weight:700;letter-spacing:.06em;padding:5px 8px;text-transform:uppercase}
.cma .bam ul{margin:0;padding:0}
.cma .bam li{list-style:none;font-size:9.5px;color:#4A5563;padding:3px 0 3px 12px;position:relative;border-bottom:1px solid #EEF1F4}
.cma .bam li:before{content:"";position:absolute;left:2px;top:8px;width:5px;height:5px;border-radius:50%;background:${or}}
.cma .bprice{position:relative;min-height:1100px;page-break-after:always;background:${nv}}
.cma .bprice .ph{position:absolute;inset:0;background-size:cover;background-position:center}
.cma .bprice .pn{position:absolute;left:8%;right:8%;top:34%;background:rgba(16,28,47,.82);border:1px solid ${or};padding:36px 30px;text-align:center}
.cma .bprice .k{color:${or};font-size:23px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}
.cma .bprice .v{color:#fff;font-size:34px;letter-spacing:.01em}
.cma .bprice .s{color:#B9C4D2;font-size:11px;margin-top:12px;line-height:1.6}
.cma .gmapimg{width:100%;height:340px;object-fit:cover;border:1px solid ${or};margin:6px 0 10px}
</style>`;
}

// ------------------------------------------------------------ gallery pages
const CONF_DEFAULT = "CONFIDENTIAL. Prepared for informational purposes only from sources believed reliable, including public records; no representation or warranty as to accuracy or completeness. All figures are estimates unless independently verified. Projections involve assumptions that may not materialize. Not an offer to sell or a solicitation. Recipients should conduct their own due diligence.";

export function generateDealDoc(deal, type) {
  const p = deal.property || {}, own = deal.ownership || {}, fin = deal.financials || {};
  const comps = deal.comps || [], rentRoll = deal.rent_roll || [], mkt = deal.market || {}, brand = deal.brand || {};
  const roll = financeRollup(deal);
  const photos = ((deal.media || {}).photos || []).filter(Boolean);
  const heroPhoto = photos[0] || "";
  const heroMap = !heroPhoto && p.lat && p.lng ? staticImg(p.lat, p.lng, 0.0013, 1200, 760) : "";
  const divMap = !heroPhoto && p.lat && p.lng ? staticImg(p.lat, p.lng, 0.0042, 1200, 900) : "";
  const hero = heroPhoto || heroMap;
  const divImg = heroPhoto || divMap;
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const brandName = brand.brand_name || "";
  const contact = brand.contact_line || brand.display_name || "";
  const nv = brand.primary_color || "#0E1F33";
  const tn = brand.accent_color || "#B08D42";
  const logo = brand.logo_url || "";
  const clean = (s) => String(s ?? "").replace(/[^\x20-\x7EÀ-ɏ]/g, "").replace(/,\s*USA\s*$/i, "").replace(/\s{2,}/g, " ").replace(/^[\s,\-–—·]+/, "").trim();
  const addr = esc(clean(p.address || deal.name) || "Untitled Asset");
  const proforma = roll.proforma, returns = roll.returns, sens = roll.sensitivity_table || [];
  const stations = mkt.stations || [], demo = mkt.demographics;
  const docTitle = type === "bov" ? "Broker's Opinion of Value" : "Offering Memorandum";
  const disclaimer = brand.disclaimer || CONF_DEFAULT;
  const copy = deal.copy || {};

  const specs = [];
  if (posNum(p.units)) specs.push(numFmt(p.units) + " units");
  if (posNum(p.sf)) specs.push(numFmt(p.sf) + " SF");
  if (p.zoning) specs.push(esc(p.zoning));
  if (p.year_built) specs.push("Built " + esc(p.year_built));
  const specLine = specs.join(" · ");
  const hasIncome = comps.length > 0 || posNum(fin.gross_income) || posNum(fin.opex) || posNum((deal.underwriting || {}).asking_price);
  const mode = !hasIncome && p.far_max && p.far_used != null && p.far_max > p.far_used ? "development" : "income";

  const foot = (label) => `<div class="gfoot"><span>${esc(contact || brandName)}</span><span>${addr} · ${esc(label)}</span></div>`;
  const rail = (rows) => `<div class="grail">${rows.map(([k, v]) => `<div class="r"><div class="v serif">${v}</div><div class="k">${k}</div></div>`).join("")}</div>`;
  const band = (cells) => `<div class="gband">${cells.map(([k, v]) => `<div class="c"><div class="v serif">${v}</div><div class="k">${k}</div></div>`).join("")}</div>`;
  const sect = (t) => `<div class="gsec">${t}</div><div class="grule"></div>`;
  const paras = (t) => String(t).split(/\n\s*\n/).map((x) => `<p class="gp">${esc(x.trim()).replace(/\n/g, " ")}</p>`).join("");

  const cover = `<div class="gpg gcover${hero ? "" : " nophoto"}">${hero ? `<div class="hero" style="background-image:url('${esc(hero)}')"></div>` : ""}<div class="band2">${hero ? '<div class="pin"></div>' : ""}<div class="doctype">${docTitle}</div><h1 class="serif">${addr}</h1>${specLine ? `<div class="sub">${specLine}</div>` : ""}${hero ? "" : '<div class="crule"></div>'}<div class="cfoot"><span>${logo ? `<img src="${esc(logo)}" style="max-height:30px;filter:brightness(0) invert(1)">` : esc(brandName || contact)}</span><span>${today}</span></div></div></div>`;

  const tocItems = (mode === "development"
    ? ["Executive Summary", "Investment Highlights", "Development & Zoning", "Location & Market"]
    : ["Property Overview", "Investment Highlights", "Financial Analysis", "Rent Roll", "Comparable Sales", "Location & Market"]
  ).filter((t) => (t === "Rent Roll" ? rentRoll.length : t === "Comparable Sales" ? comps.length : true));
  const toc = `<div class="gpg gtoc"><div class="bg"${photos[1] || hero ? ` style="background-image:url('${esc(photos[1] || hero)}')"` : ""}></div><div class="panel">${tocItems.map((t, i) => `<div class="ti"><div class="n serif">${("0" + (i + 1)).slice(-2)}</div><div class="l">${esc(t)}</div></div>`).join("")}</div></div>`;

  const railRows = mode === "development"
    ? [["Block / Lot", esc(p.bbl || "—")], ["Lot Size", numFmt(p.lot_sf) + " SF"], ["Zoning", esc(p.zoning || "—")], ["FAR used / max", (p.far_used ?? "—") + " / " + (p.far_max ?? "—")], ["Buildable (max)", p.lot_sf && p.far_max ? numFmt(Math.round(p.lot_sf * p.far_max)) + " ZFA" : "—"], ["Year built", esc(p.year_built || "—")], ["Owner", esc(own.current_owner || "—")]]
    : [["Asking", money(roll.asking_price)], ["NOI", money(roll.noi)], ["Cap rate", pctFmt(roll.cap_rate || roll.market_cap_rate)], ["Price / unit", money(roll.ppu)], ["Price / SF", roll.ppsf == null ? "—" : "$" + roll.ppsf], ["Units", numFmt(p.units)], ["Year built", esc(p.year_built || "—")]];

  const ovTitle = mode === "development" ? "Executive Summary" : "Property Overview";
  const autoOverview = `${addr} is a ${mode === "development" ? "development opportunity" : `${numFmt(p.units)}-unit ${esc(deal.asset_type || "multifamily")} asset`} totaling approximately ${numFmt(p.sf)} SF on a ${numFmt(p.lot_sf)} SF lot, zoned ${esc(p.zoning || "—")}. ${own.last_sale_price ? `The property last traded for ${money(own.last_sale_price)}${own.last_sale_date ? " in " + esc(own.last_sale_date) : ""}. ` : ""}${mode === "development" && p.far_max && p.far_used < p.far_max ? `At ${p.far_used} FAR of ${p.far_max} permitted, the site is materially underbuilt, supporting up to ~${numFmt(Math.round(p.lot_sf * p.far_max))} ZFA. ` : ""}${mode === "income" && proforma ? `In-place NOI of ${money(roll.noi)} offers upside to a stabilized ${money(proforma.noi)} at market rents. ` : ""}Owner of record: ${esc(own.current_owner || "—")}.`;
  const overviewPage = `<div class="gpg">${sect(ovTitle)}<div style="display:grid;grid-template-columns:1fr 250px;gap:26px;align-items:start"><div${copy.overview ? ' class="twocol"' : ""}>${copy.overview ? paras(copy.overview) : `<p class="gp">${autoOverview}</p>`}${mode === "income" ? `<table class="gt"><thead><tr><th>In-Place Operations</th><th class="r">Annual</th></tr></thead><tbody><tr><td>Effective gross income</td><td class="r">${money(roll.egi)}</td></tr><tr><td>Operating expenses</td><td class="r">${money(parseNum(fin.opex) != null ? -fin.opex : null)}</td></tr><tr class="tot"><td>Net operating income</td><td class="r">${money(roll.noi)}</td></tr></tbody></table>` : ""}</div>${rail(railRows)}</div>${p.lat ? `<div class="gsec" style="margin-top:14px">Aerial &amp; Parcel</div><div class="grule"></div><img class="gmapimg" src="${staticImg(p.lat, p.lng, 0.0022, 1100, 480)}" alt="Aerial">` : ""}${foot(ovTitle)}</div>`;

  const highlights = [];
  if (copy.highlights?.length) {
    for (const hl of copy.highlights) {
      const m = String(hl).match(/^([^.]+\.)\s*([\s\S]*)$/);
      highlights.push(m ? `<b>${esc(m[1])}</b> ${esc(m[2])}` : esc(hl));
    }
  } else {
    if (mode === "development" && p.far_max && p.far_used < p.far_max) highlights.push(`<b>Significant development upside.</b> Built at just ${p.far_used} of ${p.far_max} permitted FAR — up to ~${numFmt(Math.round(p.lot_sf * p.far_max))} ZFA of new development.`);
    if (mode === "income" && proforma && proforma.noi > roll.noi) highlights.push(`<b>${Math.round(((proforma.noi - roll.noi) / roll.noi) * 100)}% NOI upside.</b> In-place NOI of ${money(roll.noi)} grows to a stabilized ${money(proforma.noi)} at market rents.`);
    if (returns?.irr != null) highlights.push(`<b>Compelling levered returns.</b> A ${returns.hold_years}-year hold projects a ${pctFmt(returns.irr, 1)} levered IRR and ${returns.equity_multiple.toFixed(2)}x equity multiple at a ${pctFmt(returns.exit_cap)} exit.`);
    if (stations.length) { const st = stations[0]; highlights.push(`<b>Exceptional transit access.</b> ${st.walk_min}-minute walk to ${st.routes.map(subwayBullet).join("")} at ${esc(st.name)}.`); }
    if (demo?.median_income) highlights.push(`<b>Strong submarket fundamentals.</b> Median household income of ${money(demo.median_income)}${demo.renter_pct ? ` and ${demo.renter_pct}% renter-occupied` : ""} support durable rental demand.`);
    while (highlights.length < 3) highlights.push(`<b>Institutional-quality location.</b> ${addr} sits within a sought-after submarket with deep liquidity and resilient demand.`);
  }
  const highlightsPage = `<div class="gpg">${sect("Investment Highlights")}${highlights.slice(0, 6).map((t, i) => `<div class="ghi"><div class="num serif">${("0" + (i + 1)).slice(-2)}</div><div class="txt">${t}</div></div>`).join("")}${foot("Investment Highlights")}</div>`;

  const finPage = mode === "income" && (proforma || returns || sens.length)
    ? `<div class="gpg">${sect("Financial Analysis")}${proforma ? `<table class="gt"><thead><tr><th>Income &amp; Expense</th><th class="r">In-Place</th><th class="r">Stabilized</th></tr></thead><tbody><tr><td>Effective gross income</td><td class="r">${money(roll.egi)}</td><td class="r">${money(proforma.egi)}</td></tr><tr><td>Operating expenses</td><td class="r">${money(parseNum(fin.opex) != null ? -fin.opex : null)}</td><td class="r">${money(proforma.opex != null ? -proforma.opex : null)}</td></tr><tr class="tot"><td>Net operating income</td><td class="r">${money(roll.noi)}</td><td class="r">${money(proforma.noi)}</td></tr><tr><td>Cap on asking</td><td class="r">${pctFmt(roll.cap_rate)}</td><td class="r">${pctFmt(proforma.cap_rate)}</td></tr></tbody></table>` : ""}${returns ? band([["Levered IRR", returns.irr == null ? "—" : pctFmt(returns.irr, 1)], ["Equity multiple", returns.equity_multiple == null ? "—" : returns.equity_multiple.toFixed(2) + "x"], ["Avg CoC", pctFmt(returns.avg_coc, 1)], ["Total profit", money(returns.total_profit)]]) + `<table class="gt"><thead><tr><th>Year</th><th class="r">NOI</th><th class="r">Debt service</th><th class="r">Cash flow</th><th class="r">CoC</th><th class="r">Net reversion</th></tr></thead><tbody>${returns.rows.map((r) => `<tr${r.exit_net ? ' class="tot"' : ""}><td>Year ${r.year}</td><td class="r">${money(r.noi)}</td><td class="r">${money(r.ds)}</td><td class="r">${money(r.cf)}</td><td class="r">${pctFmt(r.coc, 1)}</td><td class="r">${r.exit_net ? money(r.exit_net) : "—"}</td></tr>`).join("")}</tbody></table>` : ""}${sens.length ? `<div class="gsec">Cap-Rate Sensitivity (±50 bps)</div><div class="grule"></div><table class="gt"><thead><tr><th>Cap</th><th class="r">Value</th><th class="r">$/Unit</th><th class="r">Δ</th></tr></thead><tbody>${sens.map((s) => `<tr${s.isBase ? ' class="tot"' : ""}><td>${s.capLabel}</td><td class="r">${money(s.value)}</td><td class="r">${money(s.ppu)}</td><td class="r">${s.deltaPct > 0 ? "+" : ""}${s.deltaPct}%</td></tr>`).join("")}</tbody></table>` : ""}${foot("Financial Analysis")}</div>`
    : "";

  const devPage = mode === "development"
    ? `<div class="gpg">${sect("Development & Zoning")}${band([["Zoning", esc(p.zoning || "—")], ["Base FAR", esc(p.far_used ?? "—")], ["Max FAR", esc(p.far_max ?? "—")], ["Max ZFA", p.lot_sf && p.far_max ? numFmt(Math.round(p.lot_sf * p.far_max)) : "—"]])}<p class="gp">The ${numFmt(p.lot_sf)} SF site is zoned ${esc(p.zoning || "—")}, permitting up to ${esc(p.far_max ?? "—")} FAR — approximately ${numFmt(Math.round((p.lot_sf || 0) * (p.far_max || 0)))} buildable SF. The current improvement uses only ${esc(p.far_used ?? "—")} FAR.</p>${foot("Development & Zoning")}</div>`
    : "";

  const rentRollPage = mode === "income" && rentRoll.length
    ? `<div class="gpg">${sect("Rent Roll")}<table class="gt"><thead><tr><th>Unit</th><th class="r">SF</th><th>Tenant</th><th class="r">Monthly rent</th><th>Lease end</th></tr></thead><tbody>${rentRoll.map((u) => `<tr><td>${esc(u.unit)}</td><td class="r">${numFmt(u.sf)}</td><td>${esc(u.tenant || "—")}</td><td class="r">${money(u.rent)}</td><td>${esc(u.lease_end || "")}</td></tr>`).join("")}<tr class="tot"><td>Total (${rentRoll.length} units)</td><td></td><td></td><td class="r">${money(rentRoll.reduce((a, u) => a + (u.rent || 0), 0))}</td><td></td></tr></tbody></table>${foot("Rent Roll")}</div>`
    : "";

  const compsPage = mode === "income" && comps.length
    ? `<div class="gpg">${sect("Comparable Sales")}<table class="gt"><thead><tr><th>Address</th><th class="r">$/Unit</th><th class="r">$/SF</th><th>Date</th></tr></thead><tbody>${comps.map((c) => `<tr><td>${esc(c.address)}</td><td class="r">${money(c.ppu)}</td><td class="r">${c.ppsf != null ? "$" + numFmt(c.ppsf) : "—"}</td><td>${esc(c.sale_date || "")}</td></tr>`).join("")}</tbody></table>${foot("Comparable Sales")}</div>`
    : "";

  const locationPage = `<div class="gpg">${sect("Location & Market")}${copy.location ? paras(copy.location) : ""}${p.lat ? `<img class="gmapimg" src="${staticImg(p.lat, p.lng, 0.008, 1100, 480)}" alt="Area">` : ""}${stations.length ? `<div class="gsec" style="margin-top:6px">Transit</div><div class="grule"></div>${stations.map((s) => `<div class="gstation">${s.routes.map(subwayBullet).join("")}<span style="margin-left:6px">${esc(s.name)}</span><span class="w">${s.walk_min} min walk · ${s.dist_mi} mi</span></div>`).join("")}` : ""}${demo ? `<div class="gsec" style="margin-top:16px">Submarket Demographics</div><div class="grule"></div><div class="gdemo">${[["Population", numFmt(demo.population)], ["Median income", money(demo.median_income)], ["Median rent", demo.median_gross_rent ? money(demo.median_gross_rent) + "/mo" : "—"], ["Renter-occupied", demo.renter_pct != null ? demo.renter_pct + "%" : "—"]].map(([k, v]) => `<div class="d"><div class="v serif">${v}</div><div class="k">${k}</div></div>`).join("")}</div>` : ""}${foot("Location & Market")}</div>`;

  const discPage = `<div class="gpg">${sect("Confidentiality & Disclaimer")}<p class="gdisc">${esc(disclaimer)}</p>${foot("Disclaimer")}</div>`;

  if (type === "deck") {
    const slide = (inner) => `<div class="gpg">${inner}</div>`;
    return galleryCss(nv, tn) + `<div class="gdoc">` +
      slide(`<div style="display:flex;flex-direction:column;justify-content:center;min-height:560px">${heroPhoto ? `<img src="${esc(heroPhoto)}" style="max-height:280px;object-fit:cover;border-radius:6px;margin-bottom:14px">` : ""}<div class="gsec" style="color:${tn}">${docTitle}</div><h1 class="serif" style="font-size:36px;margin:6px 0">${addr}</h1><p class="gp">${esc(contact)} · ${today}</p></div>`) +
      slide(sect("The Numbers") + band([["NOI", money(roll.noi)], ["Cap", pctFmt(roll.cap_rate || roll.market_cap_rate)], ["$/Unit", money(roll.ppu)], ["DSCR", roll.dscr != null ? roll.dscr.toFixed(2) + "x" : "—"]]) + (returns ? band([["Levered IRR", returns.irr == null ? "—" : pctFmt(returns.irr, 1)], ["Equity mult.", returns.equity_multiple == null ? "—" : returns.equity_multiple.toFixed(2) + "x"], ["Avg CoC", pctFmt(returns.avg_coc, 1)], ["Hold", returns.hold_years + " yr"]]) : "")) +
      slide(sect("Next Steps") + `<p class="gp" style="font-size:16px">Full offering materials, rent roll, and diligence file available on request.</p><p class="gp">${esc(contact)}</p>`) +
      `</div>`;
  }

  if (type === "bov") {
    return bovBook({ deal, roll, addr, today, hero, divImg, contact, brandName, brand, mode });
  }

  const pages = [cover, toc, overviewPage, highlightsPage];
  if (mode === "income") {
    pages.push(finPage);
    if (rentRollPage) pages.push(rentRollPage);
    if (compsPage) pages.push(compsPage);
  } else pages.push(devPage);
  pages.push(locationPage, discPage);
  return galleryCss(nv, tn) + `<div class="gdoc">${pages.filter(Boolean).join("")}</div>`;
}

// ----------------------------------------------------------------- BOV book
function bovBook({ deal, roll, addr, today, hero, divImg, contact, brandName, brand, mode }) {
  const p = deal.property || {}, own = deal.ownership || {}, fin = deal.financials || {};
  const comps = deal.comps || [], mkt = deal.market || {}, copy = deal.copy || {};
  const demo = mkt.demographics || null, stations = mkt.stations || [];
  const { nv, or, mut } = BOOK;

  // --- value reconciliation: income cap + sales comparison, outliers dropped
  const marketCap = roll.market_cap_rate;
  const noiUsed = roll.proforma?.noi ?? roll.noi;
  const incomeVal = noiUsed != null && marketCap ? noiUsed / marketCap : null;
  const capMissing = noiUsed != null && !marketCap;
  const ppuList = comps.map((c) => parseNum(c.ppu)).filter((v) => v != null);
  const ppsfList = comps.map((c) => parseNum(c.ppsf)).filter((v) => v != null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const avgPpu = avg(ppuList), avgPpsf = avg(ppsfList);
  const ppuVal = avgPpu != null && p.units ? avgPpu * p.units : null;
  const ppsfVal = avgPpsf != null && p.sf ? avgPpsf * p.sf : null;
  let indications = [];
  if (incomeVal != null && incomeVal > 0 && noiUsed > 0) indications.push({ k: "income", v: incomeVal, w: 0.5 });
  if (ppuVal != null && ppuVal > 0) indications.push({ k: "ppu", v: ppuVal, w: 0.25 });
  if (ppsfVal != null && ppsfVal > 0) indications.push({ k: "ppsf", v: ppsfVal, w: 0.25 });
  const excludedKeys = [];
  if (indications.length > 2) {
    const sorted = indications.map((i) => i.v).sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    indications = indications.filter((i) => {
      if (Math.abs(i.v - median) / median > 0.35) { excludedKeys.push(i.k); return false; }
      return true;
    });
  }
  const wSum = indications.reduce((a, i) => a + i.w, 0);
  let concluded = wSum > 0 ? indications.reduce((a, i) => a + i.v * i.w, 0) / wSum : null;
  const noiNonPos = noiUsed != null && noiUsed <= 0;
  const valid = concluded != null && isFinite(concluded) && concluded > 0 && !noiNonPos;
  const blockWhy = noiNonPos ? "net operating income is zero or negative"
    : concluded == null ? "no valid value indication could be derived from the inputs provided"
    : "the derived value is not a positive number";
  if (!valid) concluded = null;
  const stated = posNum(copy.bov_price) ?? concluded;
  const priceNotes = copy.price_notes || "";

  const pageState = { n: 1 };
  const page = (inner) => `<div class="bpg"><div class="bkey"></div><div class="bbody">${inner}</div><div class="bft"><span class="t">${addr} | <b>BROKER OPINION OF VALUE</b></span><span class="n">${pageState.n++}</span></div></div>`;
  const head = (t, sub) => `<div class="bh">${esc(t)}${sub ? ` <span>&gt; ${esc(sub)}</span>` : ""}</div>`;
  const bParas = (t) => String(t || "").split(/\n\s*\n/).filter((x) => x.trim()).map((x) => `<p class="bp">${esc(x.trim()).replace(/\n/g, " ")}</p>`).join("");
  const bg = (img) => (img ? ` style="background-image:url(&quot;${esc(img)}&quot;)"` : "");
  const divider = (t) => `<div class="bdiv"><div class="ph"${bg(divImg)}></div><div class="pn"><h2>${esc(t)}</h2></div></div>`;

  const coverPage = `<div class="bcov"><div class="ph"${bg(hero)}></div><div class="bkey"></div><div class="lt"><h1>Broker Opinion<br>of Value</h1><div class="ad">${addr}</div><div class="pb"><b>PRESENTED BY:</b>${esc(contact || brandName)}</div></div></div>`;

  const confidentiality = page(head("Confidentiality & Agreement") + `<p class="bp">This Broker's Opinion of Value (the "Opinion") has been prepared for the exclusive use of the party to whom it is addressed and is delivered on a strictly confidential basis. By accepting it, the recipient agrees to hold and treat it in the strictest confidence, not to disclose it or its contents to any other party, and to return or destroy it upon request.</p><p class="bp">The Opinion may not be reproduced or distributed, in whole or in part, and its contents may not be discussed with any employee, tenant, lender or other party connected with the property, without the prior written consent of the preparer and the owner.</p><p class="bp">The information contained herein has been obtained from sources believed to be reliable, including public records, the owner and third-party market data. It has not been independently verified, and no representation or warranty, express or implied, is made as to its accuracy or completeness. The preparer expressly disclaims any and all liability for representations or warranties, express or implied, contained in or omitted from this Opinion or any other written or oral communication transmitted to the recipient.</p><p class="bp">All figures are estimates unless independently confirmed. Square footages, lot dimensions, unit counts and year built are approximate and derived from public records; they should be independently verified. Financial information reflects the operating statements and rent roll provided by ownership and has not been audited.</p><p class="bp">This document is an opinion of value only. It is <b>not an appraisal</b> and has not been prepared under the Uniform Standards of Professional Appraisal Practice (USPAP) by a licensed appraiser. It must not be relied upon as a substitute for an appraisal, nor as legal, tax, environmental, engineering or accounting advice. The recipient should engage its own advisors in each of those disciplines.</p><p class="bp">Any projections, opinions, assumptions or estimates used are for example only and do not represent the current or future performance of the property. Actual results will differ. Market conditions, interest rates, tenancy, regulation and the physical condition of the asset may change without notice, and any of those changes may materially affect value.</p><p class="bp">No environmental, structural, mechanical, geotechnical or code-compliance investigation has been performed. The Opinion assumes the property is free of hazardous materials and structural defect, is in compliance with all applicable laws, and has clear and marketable title. No survey has been reviewed and no encumbrance, easement or encroachment has been evaluated.</p><p class="bp">The value stated assumes a sale on the open market, for cash or terms equivalent to cash, with the property exposed for a reasonable marketing period to a willing and informed buyer, neither party acting under compulsion.</p><p class="bp">This is not an offer to sell, nor the solicitation of an offer to buy, any security or interest in real property. It is not intended to solicit property already listed with another broker. We comply with all applicable federal, state and local fair housing laws.</p>`);

  const contents = `<div class="bdiv"><div class="ph"${bg(divImg)}></div><div class="pn" style="top:20%;bottom:20%;display:flex;flex-direction:column;justify-content:center;text-align:left"><h2 style="text-align:center;margin-bottom:18px">Contents</h2><div class="btoc">${[["00", "About Us"], ["01", "Executive Summary"], ["02", "Market Overview"], ["03", "Sales Comparables"], ["04", "Active Listings"], ["05", "Broker Opinion of Value"]].map(([n, l]) => `<div class="r"><span class="n">${n}</span><span class="l">${l}</span></div>`).join("")}</div></div></div>`;

  const aboutBody = copy.about ? bParas(copy.about) : "";
  const aboutPages = aboutBody ? [divider("00 · About Us"), page(head("About Us") + aboutBody)] : [];

  const execRows = [
    ["Address", addr], ["Block / Lot (BBL)", esc(p.bbl || "—")], ["Zoning", esc(p.zoning || "—")],
    ["Lot area", p.lot_sf ? numFmt(p.lot_sf) + " SF" : "—"], ["Building area (RBA)", p.sf ? numFmt(p.sf) + " SF" : "—"],
    ["Units", p.units ? numFmt(p.units) : "—"], ["Year built", esc(p.year_built || "—")],
    ["Built FAR / Max FAR", p.far_used != null && p.far_max != null ? p.far_used + " / " + p.far_max : "—"],
    ["Owner of record", esc(own.current_owner || "—")],
    ["Last sale", own.last_sale_price ? money(own.last_sale_price) + (own.last_sale_date ? ` (${esc(own.last_sale_date)})` : "") : "—"],
    ["Asking price", money(roll.asking_price)],
    ["Price / SF", roll.ppsf != null ? "$" + numFmt(roll.ppsf) : "—"], ["Price / Unit", money(roll.ppu)],
    ["Effective gross income", money(roll.egi)], ["Net operating income", money(roll.noi)],
    ["Cap rate (on asking)", roll.cap_rate ? pctFmt(roll.cap_rate) : "—"]
  ];
  const exec = page(head("Executive Summary")
    + (copy.overview ? bParas(copy.overview) : `<p class="bp">${addr}${p.neighborhood ? `, located in ${esc(p.neighborhood)},` : ""} is presented below on the basis of its physical characteristics, in-place income and the transactions of comparable assets in the submarket. The opinion of value stated in section 05 is reconciled from those approaches.</p>`)
    + `<div class="bkv" style="margin-top:14px;column-count:2;column-gap:34px">${execRows.map(([k, v]) => `<div class="r" style="break-inside:avoid"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>`
    + (p.lat ? `<img class="gmapimg" src="${staticImg(p.lat, p.lng, 0.0022, 1100, 420)}" alt="Aerial" style="height:300px;margin-top:14px">` : ""));

  const amenities = stations.length >= 8
    ? page(head("Executive Summary", "Area Amenities") + `<p class="bp">The property is served by the following transit within walking distance. Walk times are straight-line estimates from the parcel centroid.</p><div class="bam"><div><div class="hd">Transit</div><ul>${stations.slice(0, 14).map((s) => `<li>${esc(s.routes.join("/"))} — ${esc(s.name)} (${s.walk_min} min)</li>`).join("")}</ul></div></div>`)
    : "";

  const kf = (cells) => `<div class="bkf">${cells.map(([k, v]) => `<div><div class="v">${v}</div><div class="k">${k}</div></div>`).join("")}</div>`;
  const bsec = (t, inner) => `<div class="bsec"><h4>${t}</h4><div class="rule"></div>${inner}</div>`;
  let marketPage = "";
  if (demo) {
    const facts = [];
    if (demo.population != null) facts.push(["Population", numFmt(demo.population)]);
    if (demo.median_age != null) facts.push(["Median Age", numFmt(demo.median_age)]);
    if (demo.household_size != null) facts.push(["Avg Household Size", String(demo.household_size)]);
    if (demo.households != null) facts.push(["Households", numFmt(demo.households)]);
    const income = [];
    if (demo.median_income != null) income.push(["Median Household Income", money(demo.median_income)]);
    if (demo.per_capita_income != null) income.push(["Per Capita Income", money(demo.per_capita_income)]);
    if (demo.renter_pct != null) income.push(["Renter Occupied", demo.renter_pct + "%"]);
    const bars = [];
    if (demo.renter_pct != null) bars.push(["Renter occupied", demo.renter_pct]);
    if (demo.owner_pct != null) bars.push(["Owner occupied", demo.owner_pct]);
    if (demo.unemployment_pct != null) bars.push(["Unemployment", demo.unemployment_pct]);
    const barHtml = bars.map(([k, v]) => `<div class="bbar"><span class="t">${esc(k)}</span><span class="tr"><span class="fl" style="width:${Math.max(0, Math.min(100, v))}%"></span></span><span class="p">${v}%</span></div>`).join("");
    marketPage = page(head("Market Overview")
      + `<div class="bstat">${facts.length ? bsec("Key Facts", kf(facts)) : ""}${income.length ? bsec("Income", kf(income)) : ""}</div>`
      + (barHtml ? bsec("Occupancy & Employment", barHtml) : "")
      + (stations.length && stations.length < 8 ? bsec("Transit", `<div class="bkv">${stations.slice(0, 6).map((s) => `<div class="r"><span class="k">${esc(s.routes.join("/"))} — ${esc(s.name)}</span><span class="v">${s.walk_min} min walk</span></div>`).join("")}</div>`) : "")
      + (p.lat ? `<img class="gmapimg" src="${staticImg(p.lat, p.lng, 0.03, 1100, 420)}" alt="Area"><p class="bp" style="font-size:9.5px;color:${mut};margin-top:6px">Wider submarket context around the property.</p>` : ""));
  }

  const soldComps = comps.filter((c) => c.status === "Sold" || c.status === "Contract");
  const activeComps = comps.filter((c) => c.status === "Active");
  const compCard = (c, idx) => {
    const st = compStatus(c.status);
    const rows = [
      ["Sale Date", esc(c.sale_date || "—")], ["Sale Price", c.status === "Active" ? "—" : money(c.price)],
      ["Asking Price", money(c.ask_price != null ? c.ask_price : c.status === "Active" ? c.price : null)],
      ["Price/SF", c.ppsf != null ? "$" + numFmt(c.ppsf) : "—"], ["Price/AC Land Gross", c.ppac != null ? money(c.ppac) : "—"],
      ["Percent Leased", c.leased_pct != null ? c.leased_pct + "%" : "—"], ["Tenancy", esc(c.tenancy || "—")],
      ["Sale Type", esc(c.sale_type || "—")], ["Bldg Type", esc(c.bldg_type || "—")], ["Year Built", esc(c.year_built || "—")],
      ["RBA", c.sf ? numFmt(c.sf) + " SF" : "—"], ["Land Area", c.land_sf ? roundTo(c.land_sf / 43560, 2) + " AC" : "—"],
      ["Financing", esc(c.financing || "—")], ["Parcel Number", esc(c.parcel || "—")],
      ["Total Value Assessed", money(c.assessed_total)], ["Land Value Assessed", money(c.assessed_land)]
    ];
    return `<div class="bcard"><div class="im"${bg(c.photo)}></div><div class="cap"><span class="n">${idx}</span><span class="a">${esc(c.address)}</span><span class="s">${esc(st.label.toUpperCase())}</span></div><div class="bkv">${rows.map(([k, v]) => `<div class="r"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div></div>`;
  };
  const compPages = (list, title, offset) => {
    const out = [];
    for (let i = 0; i < list.length; i += 2) {
      const pair = list.slice(i, i + 2);
      out.push(page(head(title)
        + (i === 0 ? `<p class="bp">${title === "Sales Comparables" ? "Recent transactions of comparable assets in the submarket. These sales inform the sales-comparison approach applied in section 05." : "Assets currently offered in the submarket. Asking prices establish the upper bound of the market and are not evidence of transacted value."}</p>` : "")
        + `<div class="bcg">${pair.map((c, j) => compCard(c, offset + i + j + 1)).join("")}</div>`));
    }
    return out;
  };
  const soldPages = soldComps.length ? compPages(soldComps, "Sales Comparables", 0) : [];
  const activePages = activeComps.length ? compPages(activeComps, "Active Listings", soldComps.length) : [];
  const compIndex = comps.length && p.lat
    ? page(head("Comparables", "Location") + `<img class="gmapimg" src="${staticImg(p.lat, p.lng, 0.012, 1100, 460)}" alt="Comps" style="height:380px;margin:0 0 14px">` + `<div class="bkv">${comps.map((c, i) => `<div class="r"><span class="k">${i + 1}. ${esc(c.address)} — ${esc(compStatus(c.status).label)}</span><span class="v">${c.ppsf != null ? "$" + numFmt(c.ppsf) + "/SF" : "—"} · ${money(c.price)}</span></div>`).join("")}</div>`)
    : "";

  const noCompsPage = page(head("Comparables — none entered") + `<div class="reqbox"><b>No comparables were entered.</b><p>Sections 03 (Sales Comparables) and 04 (Active Listings) are absent from this document, and the sales-comparison approach could not be run. The opinion of value rests on the income approach alone and should not be relied on as a complete opinion.</p><p class="how">Add them in the Deal Calculator under <b>Comparables</b>, one per line:<br><code>address | status | sale date | sale price | asking price | RBA sf | land area sf | year built | bldg type | tenancy | % leased | sale type | financing | parcel no | assessed total | assessed land</code></p></div>`);

  const reconciled = [];
  if (incomeVal != null && noiUsed > 0 && marketCap) reconciled.push(`the income approach at a ${pctFmt(marketCap)} market capitalisation rate on ${money(noiUsed)} of net operating income, indicating ${money(roundTo(incomeVal, -3))}`);
  const areaPpsf = posNum(copy.area_ppsf) ?? avg((soldComps.length ? soldComps : comps).map((c) => parseNum(c.ppsf)).filter((v) => v != null));
  if (areaPpsf != null && p.sf) reconciled.push(`the sales-comparison approach at $${numFmt(roundTo(areaPpsf, 0))} per square foot across ${soldComps.length || comps.length} comparable${(soldComps.length || comps.length) === 1 ? "" : "s"}, indicating ${money(roundTo(areaPpsf * p.sf, -3))}`);

  const pricePage = `<div class="bprice"><div class="ph"${bg(hero)}></div><div class="bkey"></div><div class="pn"><div class="k">Price of Property</div><div class="v">${stated != null ? money(stated) : "Not stated"}</div>${stated == null ? `<div class="s">An opinion of value is not stated because ${esc(blockWhy)}. Do not distribute this draft.</div>` : `<div class="s">${priceNotes ? esc(priceNotes) : reconciled.length ? "Reconciled from " + reconciled.join("; and ") + "." : "Stated by the broker."}</div>`}</div></div>`;

  const approaches = [];
  if (incomeVal != null && noiUsed > 0 && marketCap) approaches.push(["Income capitalisation", `${money(noiUsed)} NOI ÷ ${pctFmt(marketCap)} market cap rate`, money(roundTo(incomeVal, -3))]);
  if (areaPpsf != null && p.sf) approaches.push(["Sales comparison — $/SF", `$${numFmt(roundTo(areaPpsf, 0))} / SF × ${numFmt(p.sf)} SF${soldComps.length ? ` (${soldComps.length} sale${soldComps.length === 1 ? "" : "s"})` : ""}`, money(roundTo(areaPpsf * p.sf, -3))]);
  const avgPpuAll = avg((soldComps.length ? soldComps : comps).map((c) => parseNum(c.ppu)).filter((v) => v != null));
  if (avgPpuAll != null && p.units) approaches.push(["Sales comparison — $/Unit", `${money(roundTo(avgPpuAll, 0))} / unit × ${numFmt(p.units)} units`, money(roundTo(avgPpuAll * p.units, -3))]);
  const approachesHtml = approaches.length
    ? `<div class="bh" style="margin:20px 0 8px;font-size:13px">Approaches to Value</div><div class="bkv">${approaches.map(([k, basis, v]) => `<div class="r"><span class="k"><b>${k}</b><br><span style="color:${mut};font-size:9.5px">${basis}</span></span><span class="v">${v}</span></div>`).join("")}<div class="r" style="border-bottom:none;border-top:2px solid ${nv};padding-top:10px"><span class="k"><b>Opinion of value</b></span><span class="v"><b>${stated != null ? money(stated) : "—"}</b></span></div></div>`
    : "";
  const capOmittedNote = capMissing ? `<p class="bp" style="color:#7A5B00;background:#FFF7E0;border:1px solid #E8C86A;border-radius:4px;padding:10px 12px"><b>Income approach omitted.</b> No market-derived capitalization rate was supplied, so net operating income has not been capitalized. Deriving a rate from the asking price would make this opinion circular. This conclusion rests on the sales comparison approach alone — supply a market cap rate for a fully supported opinion.</p>` : "";

  const opinionPage = page(head("Broker Opinion of Value")
    + `<p class="bp">Based on the analysis set out in this document, it is our opinion that the market value of ${addr} is <b>${stated != null ? money(stated) : "not able to be stated"}</b>${stated != null && p.sf ? ` (approximately $${numFmt(roundTo(stated / p.sf, 0))} per square foot${p.units ? `, ${money(roundTo(stated / p.units, 0))} per unit` : ""})` : ""}.</p>`
    + (reconciled.length ? `<p class="bp">This opinion is reconciled from ${reconciled.join("; and ")}.</p>` : "")
    + (priceNotes ? `<p class="bp">${esc(priceNotes)}</p>` : "")
    + capOmittedNote
    + approachesHtml
    + (posNum(copy.bov_price) != null && concluded != null && Math.abs(copy.bov_price - concluded) / concluded > 0.02 ? `<p class="bp" style="color:${mut};font-size:10px">The stated opinion reflects broker judgement and differs from the arithmetic reconciliation of the approaches above (${money(roundTo(concluded, -3))}).</p>` : "")
    + (excludedKeys.length ? `<p class="bp" style="color:${mut};font-size:10px">Excluded as outliers (>35% from the median indication): ${excludedKeys.join(", ")}.</p>` : "")
    + `<div class="bh" style="margin:20px 0 8px;font-size:13px">Assumptions &amp; Limiting Conditions</div><p class="bp">This Opinion assumes: clear and marketable title, free of liens and encumbrances other than those disclosed; no hazardous materials or environmental condition affecting value; sound structural, mechanical and roof condition, no engineering study having been performed; compliance with all applicable zoning, building and fire codes and, where relevant, continuation of the rent-regulatory and tax-abatement status described herein; that the rent roll and operating statements supplied by ownership are accurate; and a sale for cash or terms equivalent to cash following a reasonable exposure period.</p><p class="bp">No survey, title report, engineering study or environmental assessment has been reviewed. Areas and dimensions are approximate and drawn from public records. Where any assumption proves incorrect, the opinion stated above may change materially.</p><p class="bp" style="margin-top:14px">This Broker's Opinion of Value is not an appraisal and has not been prepared under the Uniform Standards of Professional Appraisal Practice by a licensed appraiser. It is an informed brokerage estimate, offered subject to the assumptions and limiting conditions set out above and to the terms of the Confidentiality &amp; Agreement page of this document.</p><p class="bp" style="margin-top:20px;margin-bottom:2px">Respectfully submitted,</p><p class="bp" style="margin:0"><b>${esc(brand.display_name || contact || brandName)}</b></p>${brand.license_number ? `<p class="bp" style="margin:0;font-size:10px;color:${mut}">License ${esc(brand.license_state || "")} ${esc(brand.license_number)}</p>` : ""}<p class="bp" style="margin:0;font-size:10px;color:${mut}">${today}</p>`);

  const pages = [coverPage, confidentiality, contents];
  pages.push(...aboutPages);
  pages.push(divider("01 · Executive Summary"), exec);
  if (amenities) pages.push(amenities);
  if (marketPage) pages.push(divider("02 · Market Overview"), marketPage);
  if (soldPages.length) { pages.push(divider("03 · Sales Comparables")); pages.push(...soldPages); }
  if (activePages.length) { pages.push(divider("04 · Active Listings")); pages.push(...activePages); }
  if (compIndex) pages.push(compIndex);
  if (!comps.length) pages.push(noCompsPage);
  pages.push(divider("05 · Broker Opinion of Value"), pricePage, opinionPage);
  return galleryCss(nv, or) + bookCss() + `<div class="gdoc cma">${pages.join("")}</div>`;
}
