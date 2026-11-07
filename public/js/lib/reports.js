// Branded printable documents: Area Investment Sales Report, Property /
// Investor Report, and the Broker Opinion of Value. Each returns a complete
// HTML string rendered in the preview modal and printable to PDF.
import { esc, num, usd, usdBig } from "./format.js";
import { POLICY_WATCH, CAP_BANDS, RENT_PSF, VACANCY, OPEX, LAND_BSF } from "./intel.js";

const NAVY = "#0b1f3a", BLUE = "#1f54c6";

const REPORT_CSS = `
  *{box-sizing:border-box} html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{max-width:880px;margin:0 auto;background:#fff;color:#16243d;font-family:"Helvetica Neue",-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:12px;line-height:1.55}
  .hero{background:linear-gradient(135deg,${NAVY} 0%,#16356b 60%,${BLUE} 130%);color:#fff;padding:26px 34px 22px;position:relative;overflow:hidden}
  .herobg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.78;z-index:0}
  .herotint{position:absolute;inset:0;z-index:1;background:linear-gradient(135deg,rgba(11,31,58,.74) 0%,rgba(16,40,80,.58) 45%,rgba(31,84,198,.42) 130%)}
  .hero>*{position:relative;z-index:2}
  .brand{font-size:10.5px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#9bc0ff}
  .hero h1{font-size:27px;margin:6px 0 4px;font-weight:800;letter-spacing:-.02em}
  .pill{display:inline-block;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);color:#eaf1ff;font-size:11px;font-weight:700;border-radius:999px;padding:3px 12px}
  .meta{color:#bcd0f0;font-size:11px;margin-top:10px}
  .body{padding:6px 34px 30px}
  h2{display:flex;align-items:center;gap:8px;font-size:12px;text-transform:uppercase;letter-spacing:1.2px;color:${NAVY};margin:26px 0 10px;font-weight:800}
  h2::before{content:"";width:18px;height:3px;background:${BLUE};border-radius:2px}
  .kpis{display:flex;gap:12px;margin:12px 0;flex-wrap:wrap}
  .kpi{flex:1;min-width:140px;border:1px solid #e1e7f0;border-top:3px solid ${BLUE};border-radius:8px;padding:13px 14px;background:#fbfcfe}
  .kpi .v{font-size:21px;font-weight:800;color:${NAVY};letter-spacing:-.02em}
  .kpi .l{font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:#6b7689;margin-top:4px;line-height:1.35}
  .kpi.amber{border-top-color:#c98a00;background:#fffdf7}
  .callout{border:1px solid #cdd9ff;background:#eef3ff;border-radius:8px;padding:14px 16px;margin:10px 0}
  .callout .big{font-size:15px;font-weight:800;color:#15315f}
  .callout p{margin:5px 0 0;color:#33405c;font-size:12px}
  .chart{margin:10px 0 4px}
  .brow{display:flex;align-items:center;gap:10px;margin:6px 0}
  .blab{width:150px;text-align:right;font-size:11px;color:#33405c;flex:none}
  .btrack{flex:1;background:#eef2f8;border-radius:5px;height:18px;overflow:hidden}
  .bfill{height:100%;border-radius:5px}
  .bval{width:96px;font-size:11px;font-weight:700;color:${NAVY};flex:none}
  table{width:100%;border-collapse:collapse;font-size:11px;margin:8px 0}
  th{text-align:right;background:${NAVY};color:#fff;padding:7px 9px;font-size:9px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
  th:first-child{text-align:left}
  td{padding:7px 9px;border-bottom:1px solid #eef2f8;text-align:right}
  td:first-child{text-align:left}
  tbody tr:nth-child(even){background:#f8fafd}
  .gap{border-left:3px solid #c98a00;background:#fffdf7;padding:8px 12px;margin:8px 0;color:#6b5a26;font-size:10.5px;border-radius:0 4px 4px 0}
  .pi{border:1px solid #e6ebf3;border-left:3px solid #1a6e4a;border-radius:6px;padding:9px 12px;margin:8px 0;background:#fbfcfe}
  .pi .t{font-weight:800;color:${NAVY}}
  .pi .tag{font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;border:1px solid;border-radius:3px;padding:1px 6px;margin-left:6px}
  .pi .d{color:#33405c;margin-top:4px}
  p{margin:6px 0}
  .propchip{display:inline-block;min-width:26px;text-align:center;font-weight:800;font-size:11px;border-radius:5px;padding:2px 7px;color:#fff}
  .p-hi{background:#b42318}.p-el{background:#b54708}.p-wa{background:#9a7400}
  .sumgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 26px;border:1px solid #e6ebf3;border-radius:8px;padding:6px 16px;background:#fbfcfe}
  .sx{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef2f8;gap:12px}
  .sk{color:#6b7689;font-size:11px}.sv{font-weight:700;color:${NAVY};font-size:12px;text-align:right}
  .sigcards{display:flex;gap:12px;margin:8px 0;flex-wrap:wrap}
  .sigcard{flex:1;min-width:220px;border:1px solid #e1e7f0;border-top:3px solid #475467;border-radius:8px;padding:12px 14px;background:#fbfcfe}
  .sigcard .sgl{font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:#6b7689;font-weight:700}
  .sigcard .sgv{font-size:18px;font-weight:800;margin-top:2px}
  .sigcard ul{margin:8px 0 0;padding-left:16px}.sigcard li{font-size:10px;color:#33405c;margin-top:3px;line-height:1.45}
  .sigrow{font-size:11px;color:#33405c;margin:6px 0;padding:6px 10px;background:#f6f8fc;border:1px solid #e6ebf3;border-radius:6px}
  .foot{margin-top:24px;border-top:1px solid #dde4ee;padding-top:10px;font-size:9px;color:#9099ac;line-height:1.6}
  @media print{@page{margin:.5in}}
`;

const boroKey = (b) => (["Manhattan", "Brooklyn", "Queens", "Bronx"].includes(b) ? b : "default");
const bandColors = ["#1f54c6", "#2f6be0", "#4f86ec", "#74a2f2", "#9cbef7", "#c3d6fb", "#8a93a8"];
function barChart(rows) {
  if (!rows.length) return "";
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="chart">${rows.map((r, i) =>
    `<div class="brow"><div class="blab">${esc(r.label)}</div><div class="btrack"><div class="bfill" style="width:${Math.max(1.5, (r.value / max) * 100)}%;background:${bandColors[i % bandColors.length]}"></div></div><div class="bval">${r.disp}</div></div>`).join("")}</div>`;
}
function histogramSvg(dist) {
  if (!dist || dist.length < 2) return "";
  const max = Math.max(...dist.map((d) => d.count), 1);
  const W = 640, H = 208, L = 40, R = 16, T = 16, B = 48, gap = 6;
  const n = dist.length, bw = (W - L - R - (n - 1) * gap) / n;
  const bars = dist.map((d, i) => {
    const bh = (d.count / max) * (H - T - B);
    const x = L + i * (bw + gap), y = H - B - bh;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" rx="2" fill="${BLUE}"/>
      <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="${NAVY}">${d.count || ""}</text>
      <text x="${(x + bw / 2).toFixed(1)}" y="${H - B + 13}" text-anchor="end" font-size="7.5" fill="#6b7689" transform="rotate(-35 ${(x + bw / 2).toFixed(1)} ${H - B + 13})">${esc(d.label)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:640px"><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#dde4ee"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#dde4ee"/><text x="${L - 6}" y="${T + 4}" text-anchor="end" font-size="9" fill="#8a93a8">${max}</text><text x="14" y="${(H - B + T) / 2}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#33405c" transform="rotate(-90 14 ${(H - B + T) / 2})"># of sales</text>${bars}</svg>`;
}
function trendSvg(hist) {
  const pts = (hist ?? []).filter((p) => Number.isFinite(p.ppsf));
  if (pts.length < 2) return "";
  const W = 640, H = 150, xs = pts.map((_, i) => 46 + (i / (pts.length - 1)) * 578);
  const vals = pts.map((p) => p.ppsf), lo = Math.min(...vals), hi = Math.max(...vals);
  const y = (v) => 14 + (1 - (v - lo) / Math.max(hi - lo, 1)) * 110;
  const line = pts.map((p, i) => `${xs[i].toFixed(1)},${y(p.ppsf).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:640px"><polygon points="46,124 ${line} 624,124" fill="${BLUE}" opacity="0.08"/><polyline points="${line}" fill="none" stroke="${BLUE}" stroke-width="2"/>${pts.map((p, i) => `<circle cx="${xs[i].toFixed(1)}" cy="${y(p.ppsf).toFixed(1)}" r="2.6" fill="${BLUE}"/><text x="${xs[i].toFixed(1)}" y="142" text-anchor="middle" font-size="9" fill="#8a93a8">${p.year}</text><text x="${xs[i].toFixed(1)}" y="${(y(p.ppsf) - 7).toFixed(1)}" text-anchor="middle" font-size="8.5" font-weight="700" fill="${NAVY}">$${Math.round(p.ppsf).toLocaleString()}</text>`).join("")}</svg>`;
}

function yieldBenchmark(mode, avgPpsf, borough) {
  const key = boroKey(borough || "default");
  if (mode === "development") {
    const [lo, hi] = LAND_BSF[key] ?? LAND_BSF.default;
    return `<h2>Market benchmark — for buyers &amp; sellers</h2>
      <div class="kpis"><div class="kpi amber"><div class="v">$${lo}–$${hi}/BSF</div><div class="l">Land value per buildable SF (market)</div></div>
      <div class="kpi amber"><div class="v">${avgPpsf ? "$" + avgPpsf.toLocaleString() + "/sf" : "—"}</div><div class="l">Live avg sale $/land-sf (area)</div></div></div>
      <div class="callout"><div class="big">How to read this</div><p>Development sites price on <b>buildable square footage</b> (zoning floor area = lot × allowable FAR), not in-place income — so cap rate and GRM don't apply. The market benchmark is what comparable sites are trading for <b>per buildable SF</b>.</p></div>
      <div class="gap"><b>Estimate — market benchmark, not this site's figure.</b> A specific site's value depends on its exact zoning, achievable FAR, and any bonus/affordability program — verify the buildable area before underwriting.</div>`;
  }
  if (mode === "hotels") return `<h2>Market yield benchmark</h2><div class="gap">Hotels are valued on RevPAR / operating income, not rent/sf — a rent-based cap rate would mislead, so it's omitted.</div>`;
  const cls = CAP_BANDS[mode] ? mode : "misc";
  const band = (CAP_BANDS[cls] ?? CAP_BANDS.misc)[key] ?? CAP_BANDS.misc.default;
  const rent = (RENT_PSF[cls] ?? RENT_PSF.misc)[key] ?? 65;
  const vac = VACANCY[cls] ?? 0.08, opx = OPEX[cls] ?? 0.45;
  const priced = avgPpsf && Number.isFinite(avgPpsf) && avgPpsf > 0;
  const noiPsf = rent * (1 - vac) * (1 - opx);
  const capPct = priced ? Math.round((noiPsf / avgPpsf) * 1000) / 10 : null;
  const grm = priced ? Math.round((avgPpsf / rent) * 10) / 10 : null;
  return `<h2>Market yield benchmark — for buyers &amp; sellers</h2>
    <div class="kpis"><div class="kpi"><div class="v">${band.low}–${band.high}%</div><div class="l">Prevailing market cap range</div></div>
    <div class="kpi"><div class="v">${capPct != null ? "~" + capPct + "%" : "—"}</div><div class="l">Indicative modeled cap (est.)</div></div>
    <div class="kpi"><div class="v">${grm != null ? grm + "×" : "—"}</div><div class="l">GRM — gross rent multiplier</div></div>
    <div class="kpi"><div class="v">$${rent}/sf</div><div class="l">Assumed market rent (yr)</div></div></div>
    <div class="callout"><div class="big">How to read this</div><p>The <b>market cap range</b> is where comparable assets are pricing in this submarket today (${esc(band.note)}) — a negotiating benchmark, not a property figure. <b>GRM</b> is gross (price ÷ gross rent), so it needs no income disclosure.${capPct != null ? ` The <b>indicative modeled cap (~${capPct}%)</b> applies an assumed $${rent}/sf rent, ${Math.round(vac * 100)}% vacancy and ${Math.round(opx * 100)}% opex to the live $${Math.round(avgPpsf).toLocaleString()}/sf sale price — it sits ${capPct >= band.low && capPct <= band.high ? "inside" : "outside"} the market band.` : ""}</p></div>
    <div class="gap"><b>Buyer NOI ≠ seller NOI.</b> A buyer's realized yield will differ from a seller's — tax reassessment on sale, new financing, management and capex all move NOI — so this is a <b>market range to negotiate against, not an appraisal or a guaranteed return</b>.</div>`;
}

export function marketReportHtml({ label, zips, borough, ppsfHistory, history, assetClass, report, radar }) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const cls = assetClass ?? "multifamily";
  const byClass = report?.byClass ?? [];
  const inv = byClass.filter((c) => !c.churn);
  const invSales = inv.reduce((n, c) => n + (c.salesCount || 0), 0);
  const invDollar = inv.reduce((n, c) => n + (c.dollarVolume || 0), 0);
  const primary = byClass.find((c) => c.mode === cls) || byClass.find((c) => c.mode === "multifamily");
  const rows = byClass.filter((c) => (c.salesCount || 0) > 0 || (c.stock || 0) > 0).map((c) => {
    const label2 = esc(c.class) + (c.churn ? ' <span style="color:#8a93a8;font-weight:400">(unit sales)</span>' : "");
    const to = c.churn ? "—" : c.turnoverPct != null ? `${c.turnoverPct}%${c.impliedHoldYears ? ` <span style="color:#8a93a8">· ~${c.impliedHoldYears}y</span>` : ""}` : "—";
    return `<tr><td><strong>${label2}</strong></td><td>${num(c.salesCount)}</td><td>${usdBig(c.dollarVolume)}</td><td>${usd(c.avgPrice)}</td><td>${c.avgPpsf ? "$" + c.avgPpsf.toLocaleString() : "—"}</td><td>${to}</td></tr>`;
  }).join("");
  const dollarBars = inv.filter((c) => c.dollarVolume > 0).sort((a, b) => b.dollarVolume - a.dollarVolume).slice(0, 7)
    .map((c) => ({ label: c.class, value: c.dollarVolume, disp: usdBig(c.dollarVolume) }));
  const turnoverBars = inv.filter((c) => c.turnoverPct != null && c.salesCount > 0).sort((a, b) => b.turnoverPct - a.turnoverPct)
    .map((c) => ({ label: c.class, value: c.turnoverPct, disp: `${c.turnoverPct}%${c.impliedHoldYears ? ` · ~${c.impliedHoldYears}y` : ""}` }));
  const policy = POLICY_WATCH[cls] ?? POLICY_WATCH.misc;
  const statusColor = { Enacted: "#1a6e4a", Effective: "#1a6e4a", Active: "#1f54c6", Proposed: "#9a6700" };
  const policyHtml = `<h2>${esc(policy.heading)}</h2><p style="color:#5a6a8a">${esc(policy.intro)}</p>` +
    policy.items.map((it) => `<div class="pi" style="border-left-color:${statusColor[it.status] ?? BLUE}"><div class="t">${esc(it.title)}<span class="tag" style="color:${statusColor[it.status] ?? BLUE};border-color:${statusColor[it.status] ?? BLUE}">${esc(it.status)}</span></div><div class="d">${esc(it.summary)}</div></div>`).join("");
  const radarRows = (radar ?? []).map((b) => `<tr><td><strong>${esc(b.address)}</strong></td><td>${esc(b.owner || "—")}</td><td><span class="propchip ${b.propensity >= 55 ? "p-hi" : b.propensity >= 35 ? "p-el" : "p-wa"}">${b.propensity}</span></td><td style="font-size:10px;color:#33405c;text-align:left">${esc(b.propensityWhy || "—")}</td></tr>`).join("");
  const heroImg = `/api/staticmap?q=${encodeURIComponent(label)}&size=900x300`;
  return `<style>${REPORT_CSS}</style><div class="sheet">
    <div class="hero"><img class="herobg" src="${heroImg}" onerror="this.style.display='none'"/><div class="herotint"></div>
      <div class="brand">NYC RE Market Intel · Area Investment Sales Report</div>
      <h1>${esc(label)}</h1>
      <span class="pill">Prepared for: property owners &amp; investors</span>
      <div class="meta">${borough ? esc(borough) + " · " : ""}ZIP ${esc(zips.join(", "))} · sales trailing 12 months · generated ${today}</div>
    </div>
    <div class="body">
      <h2>Market at a glance</h2>
      <div class="kpis">
        <div class="kpi"><div class="v">${usdBig(invDollar)}</div><div class="l">Area investment dollar volume</div></div>
        <div class="kpi"><div class="v">${num(primary?.salesCount)}</div><div class="l">Primary-class sales, 12 mo</div></div>
        <div class="kpi"><div class="v">${primary?.turnoverPct != null ? primary.turnoverPct + "%" : "—"}</div><div class="l">Turnover${primary?.impliedHoldYears ? ` · ~${primary.impliedHoldYears}y hold` : ""}</div></div>
        <div class="kpi"><div class="v">${usd(primary?.avgPrice)}</div><div class="l">Avg price / building</div></div>
      </div>
      ${report?.recordedTotal ? `<h2>What actually traded</h2><div class="callout"><div class="big">${num(report.recordedTotal)} recorded transactions → ${num(invSales)} actual building sales</div><p>The remainder were individual condo apartments and co-op units — filtered out so the figures reflect how the investment market actually trades.</p></div>` : ""}
      ${report?.narrative?.length ? `<h2>Market narrative</h2>${report.narrative.map((p) => `<p>${esc(p)}</p>`).join("")}` : ""}
      ${dollarBars.length ? `<h2>Dollar volume by product type</h2>${barChart(dollarBars)}` : ""}
      <h2>By product type</h2>
      <table><thead><tr><th>Product type</th><th># sales</th><th>Dollar volume</th><th>Avg / building</th><th>Avg $/sf</th><th>Turnover</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No sales data.</td></tr>`}</tbody></table>
      ${turnoverBars.length ? `<h2>Turnover by product type (liquidity)</h2><p style="color:#5a6a8a;margin-top:0">Share of standing stock that traded in the trailing year — higher = more liquid.</p>${barChart(turnoverBars)}` : ""}
      ${yieldBenchmark(cls, primary?.avgPpsf, borough)}
      ${radarRows ? `<h2>Off-market radar — most likely to sell <span style="font-size:8px;border:1px solid ${BLUE};color:${BLUE};border-radius:4px;padding:1px 6px">BETA</span></h2>
        <p style="color:#5a6a8a;margin-top:0">Highest modeled <b>seller-propensity</b> lots in this submarket, from free public-record signals. Open any in the Parcel Dossier for owner contacts and the full distress / debt-maturity read.</p>
        <table><thead><tr><th>Address</th><th>Owner of record</th><th>Propensity</th><th style="text-align:left">Why now</th></tr></thead><tbody>${radarRows}</tbody></table>
        <div class="gap">Modeled signal — ranks where to spend outreach time, not a prediction of price or a guarantee. Verify ownership intent and any active filings before acting.</div>` : ""}
      ${policyHtml}
      ${report?.distribution?.length ? `<h2>Where sales priced — sale $/sf distribution</h2><p style="color:#5a6a8a;margin-top:0">Each bar = the number of investment-property sales that closed in that price-per-square-foot range. Taller bars mean more deals clustered at that price level.</p>${histogramSvg(report.distribution)}` : ""}
      ${trendSvg(ppsfHistory) ? `<h2>Price trend — estimated sale $/sf over time</h2><p style="color:#5a6a8a;margin-top:0">Researched directional estimate of the area's average sale price per square foot by year — cycle context, <b>not</b> a verified transaction series.</p>${trendSvg(ppsfHistory)}` : ""}
      ${history?.length ? `<h2>Neighborhood overview</h2>${history.map((p) => `<p>${esc(p)}</p>`).join("")}` : ""}
      <div class="foot">Sources: recorded citywide sales (sale counts, dollar volume, $/sf) and public property records (building stock for turnover). Turnover = sales ÷ standing stock; implied hold = 1 ÷ turnover. Investment view excludes individual condo/co-op unit sales. Estimated cap rate &amp; GRM are MODELED from researched market-rent assumptions, not verified income. Not an appraisal. Generated ${today} via NYC RE Market Intel.</div>
    </div></div>`;
}

export function propertyReportHtml({ record, propensity, distress, cliffs, lien, preparedBy, mode = "internal" }) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const investor = mode === "investor";
  const p = record.pluto ?? {};
  const m = record.metrics ?? {};
  const addr = record.address || `BBL ${record.bbl}`;
  const unused = p.maxFar && p.lotArea ? Math.round(Math.max(0, p.maxFar - (p.builtFar || 0)) * p.lotArea) : 0;
  const money = (v) => (v != null && Number.isFinite(+v) && +v > 0 ? "$" + Math.round(+v).toLocaleString() : "—");
  const yr = (v) => (v && +v > 1700 ? String(Math.round(+v)) : "—");
  const bandColor = (b) => (b === "High" ? "#b42318" : b === "Elevated" ? "#b54708" : b === "Watch" ? "#9a7400" : "#475467");
  const summary = [
    ["Building class", p.bldgClass || "—"], ["Year built / renovated", `${yr(p.yearBuilt)} / ${yr(p.yearAlter1)}`],
    ["Building size", p.bldgArea ? num(p.bldgArea) + " SqFt" : "—"], ["Floors", p.numFloors ?? "—"],
    ["Zoning", p.zoning || "—"], ["Lot size", p.lotArea ? `${num(p.lotArea)} SqFt · ${(p.lotArea / 43560).toFixed(3)} ac` : "—"],
    ["Units", p.unitsTotal ?? p.unitsRes ?? "—"], ["Built / Max FAR", `${p.builtFar != null ? (+p.builtFar).toFixed(2) : "—"} / ${p.maxFar != null ? (+p.maxFar).toFixed(2) : "—"}`],
    ["Owner of record", p.owner || "—"]
  ].map(([k, v]) => `<div class="sx"><div class="sk">${esc(k)}</div><div class="sv">${esc(String(v))}</div></div>`).join("");
  const compRows = `<tr><td><strong>${esc(addr)}</strong> <span style="color:#8a93a8">(subject)</span></td><td>—</td><td>${yr(p.yearBuilt)}</td><td>${p.numFloors || "—"}</td><td>${p.bldgArea ? num(p.bldgArea) : "—"}</td><td>${p.unitsTotal ?? p.unitsRes ?? "—"}</td></tr>` +
    (record.competitiveSet ?? []).map((c, i) => `<tr><td><strong>${String.fromCharCode(65 + i)}</strong> &nbsp;${esc(c.address)}</td><td>${c.distanceMi != null ? c.distanceMi + " mi" : "—"}</td><td>${yr(c.yearBuilt)}</td><td>${c.numFloors || "—"}</td><td>${c.bldgArea ? num(c.bldgArea) : "—"}</td><td>${c.units || "—"}</td></tr>`).join("");
  const saleRows = (record.sales ?? []).length
    ? record.sales.map((s) => `<tr><td>${esc(s.date || "—")}</td><td>${s.amount > 0 ? money(s.amount) : "—"}</td><td style="text-align:left">${esc(s.grantor || "—")}</td><td style="text-align:left">${esc(s.grantee || "—")}</td></tr>`).join("")
    : `<tr><td colspan="4">No recorded deeds found.</td></tr>`;
  const a = record.assessment ?? {};
  const debtRow = distress?.debt
    ? `<div class="sigrow"><b>Debt maturity (estimated):</b> ${money(distress.debt.amount)} from ${esc(distress.debt.lender)} recorded ${String(distress.debt.date).slice(0, 4)} — ${distress.debt.status === "past" ? `<span style="color:#b42318;font-weight:700">past est. maturity (~${distress.debt.estMaturityYear})</span>` : distress.debt.status === "approaching" ? `<span style="color:#b54708;font-weight:700">maturing ~${distress.debt.estMaturityYear}</span>` : `est. maturity ~${distress.debt.estMaturityYear}`}</div>`
    : `<div class="sigrow">No recorded mortgage on this lot — likely owned free &amp; clear or via an unrecorded structure.</div>`;
  const lienRow = lien ? (lien.onList
    ? `<div class="sigrow" style="color:#b42318;font-weight:700">⚠ On the NYC tax/water lien-sale list (${lien.records.length} entr${lien.records.length === 1 ? "y" : "ies"}) — direct distress signal.</div>`
    : `<div class="sigrow">Not on the NYC tax/water lien-sale list — no lien-sale exposure on record.</div>`) : "";
  const cliffRows = [
    cliffs?.j51 ? `<div class="sigrow"><b>J-51 abatement:</b> ${cliffs.j51.exYears}-yr exemption from ${cliffs.j51.initYear} — ${cliffs.j51.status === "expired" ? `burned off ~${cliffs.j51.endYear} (taxes stepped up)` : cliffs.j51.status === "expiring" ? `<span style="color:#b54708;font-weight:700">burns off ~${cliffs.j51.endYear} — tax step-up imminent</span>` : `runs through ~${cliffs.j51.endYear}`}.</div>` : "",
    cliffs?.ll97 ? `<div class="sigrow"><b>Local Law 97 (2030):</b> ${esc(cliffs.ll97.type)}, ${cliffs.ll97.ghg.toLocaleString()} tCO₂e vs ~${cliffs.ll97.capTons.toLocaleString()} t cap — ${cliffs.ll97.status === "exposed" ? `<span style="color:#b42318;font-weight:700">~$${cliffs.ll97.penalty2030.toLocaleString()}/yr estimated penalty from 2030</span>` : "projected compliant"}.</div>` : ""
  ].join("");
  const signals = investor ? "" : `<h2>Investment signals <span style="font-size:8px;border:1px solid ${BLUE};color:${BLUE};border-radius:4px;padding:1px 6px">BETA</span></h2>
    <div class="sigcards">
      <div class="sigcard" style="border-top-color:${bandColor(propensity?.band)}"><div class="sgl">Seller-propensity</div><div class="sgv" style="color:${bandColor(propensity?.band)}">${propensity?.band ?? "—"} · ${propensity?.score ?? 0}/100</div>${propensity?.reasons?.length ? `<ul>${propensity.reasons.slice(0, 4).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : `<div style="font-size:10px;color:#8a93a8;margin-top:8px">No strong seller signals on the public record.</div>`}</div>
      <div class="sigcard" style="border-top-color:${bandColor(distress?.band)}"><div class="sgl">Distress / motivated-seller</div><div class="sgv" style="color:${bandColor(distress?.band)}">${distress?.band ?? "—"} · ${distress?.distressScore ?? 0}/100</div>${distress?.reasons?.length ? `<ul>${distress.reasons.slice(0, 4).map((r) => `<li><b>${esc(r.label)}</b> — ${esc(r.detail)}</li>`).join("")}</ul>` : `<div style="font-size:10px;color:#8a93a8;margin-top:8px">No distress markers — a relationship / timing play.</div>`}</div>
    </div>
    ${debtRow}${lienRow}${cliffRows}
    <div class="gap">Seller-propensity and distress are <b>modeled signals</b> from public records — they rank where to spend outreach time, not a prediction of price or a guarantee. Debt maturity is estimated from the recorded mortgage date (NYC publishes no loan terms).</div>`;
  return `<style>${REPORT_CSS}</style><div class="sheet">
    <div class="hero"><img class="herobg" src="/api/staticmap?bbl=${record.bbl}&size=900x300" onerror="this.style.display='none'"/><div class="herotint"></div>
      <div class="brand">NYC RE Market Intel · ${investor ? "Investor Report" : "Property Report"}</div>
      <h1>${esc(addr)}</h1>
      <div class="meta">BBL ${record.bbl}${p.zip ? " · " + p.zip : ""}${p.zoning ? " · " + esc(p.zoning) : ""} · Prepared by ${esc(preparedBy || "—")} · ${today}</div>
    </div>
    <div class="body">
      <div class="kpis" style="margin-top:18px">
        <div class="kpi"><div class="v">${m.lastSalePrice ? money(m.lastSalePrice) : "—"}</div><div class="l">Last sale${m.lastSaleDate ? " · " + String(m.lastSaleDate).slice(0, 4) : ""}</div></div>
        <div class="kpi"><div class="v">${m.lastSalePpsf ? money(m.lastSalePpsf) : "—"}</div><div class="l">Last sale $/SqFt</div></div>
        <div class="kpi"><div class="v">${m.holdYears != null ? m.holdYears + " yrs" : "—"}</div><div class="l">Hold period</div></div>
        <div class="kpi"><div class="v">${a.assessTotal ? money(a.assessTotal) : "—"}</div><div class="l">Assessed value</div></div>
        <div class="kpi"><div class="v">${unused > 0 ? num(unused) + " sf" : "—"}</div><div class="l">Unused FAR</div></div>
      </div>
      ${signals}
      <h2>Property summary</h2><div class="sumgrid">${summary}</div>
      <h2>Competitive set — nearest comparable buildings</h2>
      <table><thead><tr><th>Address</th><th>Distance</th><th>Yr built</th><th>Floors</th><th>Size</th><th>Units</th></tr></thead><tbody>${compRows}</tbody></table>
      <h2>Sales &amp; ownership history</h2>
      <table><thead><tr><th>Recorded</th><th>Price</th><th style="text-align:left">Seller (grantor)</th><th style="text-align:left">Buyer (grantee)</th></tr></thead><tbody>${saleRows}</tbody></table>
      <h2>Tax &amp; assessment</h2>
      <div class="kpis">
        <div class="kpi"><div class="v">${money(a.assessTotal)}</div><div class="l">Assessed value (total)</div></div>
        <div class="kpi"><div class="v">${money(a.assessLand)}</div><div class="l">Assessed — land</div></div>
        <div class="kpi"><div class="v">${money(a.assessImprovements)}</div><div class="l">Assessed — improvements</div></div>
        <div class="kpi"><div class="v">${money(a.exemptTotal)}</div><div class="l">Exemptions</div></div>
      </div>
      <div class="foot">Sources: public property records (physical / assessment), recorded deeds &amp; ownership, recorded citywide sales. Competitive set is nearest same-class lots by distance. All figures are live public-record pulls — not an appraisal, and to be verified by inspection and the appropriate professionals. Prepared by ${esc(preparedBy || "—")} · Generated ${today} via NYC RE Market Intel.</div>
    </div></div>`;
}

// --- Broker Opinion of Value (navy + orange book) ---------------------------
const BOV_NV = "#101C2F", BOV_OR = "#E4873C";
export function bovHtml({ address, property, uw, comps, contact, priceNotes, bovPrice }) {
  let pageNo = 0;
  const page = (body) => {
    pageNo += 1;
    return `<div style="position:relative;background:#fff;color:#26313F;min-height:1040px;page-break-after:always;font-family:Inter,system-ui,sans-serif">
      <div style="position:absolute;inset:16px;border:1px solid ${BOV_OR};pointer-events:none"></div>
      <div style="position:relative;padding:46px 46px 60px">${body}</div>
      <div style="position:absolute;left:16px;right:16px;bottom:16px;background:${BOV_NV};color:#C4CEDA;display:flex;align-items:center;justify-content:flex-end;font-size:9.5px;height:30px">
        <span style="padding-right:14px">${esc(address)} | <b style="color:${BOV_OR}">BROKER OPINION OF VALUE</b></span>
        <span style="background:${BOV_OR};color:${BOV_NV};font-weight:700;font-size:11px;min-width:34px;height:30px;display:flex;align-items:center;justify-content:center">${pageNo}</span>
      </div></div>`;
  };
  const head = (t) => `<div style="color:${BOV_OR};font-size:16px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin:0 0 16px">${esc(t)}</div>`;
  const para = (t) => `<p style="font-size:12px;line-height:1.75;color:#3A4654;margin:0 0 12px">${esc(t)}</p>`;
  const kvRows = (pairs) => `<div>${pairs.map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:11.5px;padding:9px 3px;border-bottom:1px solid #ECEFF3"><span style="color:#1B2430;font-weight:600">${esc(k)}</span><span style="color:#4A5563;text-align:right">${v}</span></div>`).join("")}</div>`;
  const cover = `<div style="position:relative;min-height:1040px;background:${BOV_NV};page-break-after:always;display:flex">
    <div style="position:absolute;inset:16px;border:1px solid ${BOV_OR};pointer-events:none"></div>
    <div style="position:relative;width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 60px">
      <h1 style="color:${BOV_OR};font-size:30px;font-weight:700;letter-spacing:.02em;line-height:1.25;margin:0 0 14px;text-transform:uppercase">Broker Opinion<br>of Value</h1>
      <div style="color:#E7EDF4;font-size:15px;line-height:1.55">${esc(address)}</div>
      <div style="position:absolute;bottom:84px;left:0;right:0;text-align:center;font-size:10.5px;line-height:1.6;color:#C4CEDA"><b style="color:${BOV_OR};display:block;font-size:9.5px;letter-spacing:.14em">PRESENTED BY:</b>${esc(contact || "NYC RE Market Intel")}</div>
    </div></div>`;
  const confidentiality = page(head("Confidentiality & Agreement") +
    para(`This Broker's Opinion of Value (the "Opinion") has been prepared for the exclusive use of the party to whom it is addressed and is delivered on a strictly confidential basis. By accepting it, the recipient agrees to hold and treat it in the strictest confidence, not to disclose it or its contents to any other party, and to return or destroy it upon request.`) +
    para("The information contained herein has been obtained from sources believed to be reliable, including public records, the owner and third-party market data. It has not been independently verified, and no representation or warranty, express or implied, is made as to its accuracy or completeness.") +
    para("All figures are estimates unless independently confirmed. Square footages, lot dimensions, unit counts and year built are approximate and derived from public records; they should be independently verified. Financial information reflects the operating statements and rent roll provided by ownership and has not been audited.") +
    para("This document is an opinion of value only. It is not an appraisal and has not been prepared under the Uniform Standards of Professional Appraisal Practice (USPAP) by a licensed appraiser. It must not be relied upon as a substitute for an appraisal, nor as legal, tax, environmental, engineering or accounting advice.") +
    para("Any projections, opinions, assumptions or estimates used are for example only and do not represent the current or future performance of the property. Actual results will differ. Market conditions, interest rates, tenancy, regulation and the physical condition of the asset may change without notice.") +
    para("The value stated assumes a sale on the open market, for cash or terms equivalent to cash, with the property exposed for a reasonable marketing period to a willing and informed buyer, neither party acting under compulsion.") +
    para("This is not an offer to sell, nor the solicitation of an offer to buy, any security or interest in real property. It is not intended to solicit property already listed with another broker. We comply with all applicable federal, state and local fair housing laws."));
  const exec = page(head("Executive Summary") +
    para(`${address} is presented below on the basis of its physical characteristics, in-place income and the transactions of comparable assets in the submarket. The opinion of value stated at the end of this book is reconciled from those approaches.`) +
    `<div style="column-count:2;column-gap:34px;margin-top:14px">` + kvRows([
      ["Address", esc(address)], ["Block / Lot (BBL)", esc(property.bbl ?? "—")], ["Zoning", esc(property.zoning ?? "—")],
      ["Lot area", property.lot_sf ? num(property.lot_sf) + " SF" : "—"], ["Building area (RBA)", property.sf ? num(property.sf) + " SF" : "—"],
      ["Units", property.units ? num(property.units) : "—"], ["Year built", esc(String(property.year_built ?? "—"))],
      ["Built / Max FAR", property.far_used != null && property.far_max != null ? `${property.far_used} / ${property.far_max}` : "—"],
      ["Owner of record", esc(property.owner ?? "—")], ["Asking price", usd(uw?.asking_price)],
      ["Price / SF", uw?.ppsf != null ? "$" + num(uw.ppsf) : "—"], ["Price / Unit", uw?.ppu != null ? usd(uw.ppu) : "—"],
      ["Effective gross income", usd(uw?.egi)], ["Net operating income", usd(uw?.noi)],
      ["Cap rate (on asking)", uw?.cap_rate ? (uw.cap_rate * 100).toFixed(2) + "%" : "—"], ["DSCR", uw?.dscr != null ? uw.dscr + "×" : "—"]
    ]) + `</div>`);
  const soldComps = (comps ?? []).filter((c) => c.status !== "Active");
  const activeComps = (comps ?? []).filter((c) => c.status === "Active");
  const compTable = (list, title) => page(head(title) + `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:6px">
    <thead><tr>${["Address", "Status", "Date", "Price", "$/SF", "Units"].map((t) => `<th style="background:${BOV_NV};color:#fff;padding:7px 9px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;text-align:left">${t}</th>`).join("")}</tr></thead>
    <tbody>${list.length ? list.map((c) => `<tr>${[esc(c.address), esc(c.status ?? "Sold"), esc(c.date ?? "—"), usd(c.price), c.ppsf ? "$" + num(c.ppsf) : "—", c.units ?? "—"].map((v) => `<td style="padding:8px 9px;border-bottom:1px solid #ECEFF3">${v}</td>`).join("")}</tr>`).join("") : `<tr><td style="padding:10px" colspan="6">None provided — paste comps in the calculator's comp box to populate this section.</td></tr>`}</tbody></table>`);
  const sens = uw?.sensitivity_table?.length ? page(head("Value Sensitivity") +
    para("Value moves inversely with the capitalization rate applied to stabilized income. The band below brackets the concluded range ±50 bps.") +
    `<table style="width:100%;border-collapse:collapse;font-size:11.5px"><thead><tr>${["Cap rate", "Implied value", "$/Unit", "$/SF", "Δ vs base"].map((t) => `<th style="background:${BOV_NV};color:#fff;padding:7px 9px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;text-align:left">${t}</th>`).join("")}</tr></thead>
    <tbody>${uw.sensitivity_table.map((r) => `<tr style="${r.isBase ? "background:#FDF3E7;font-weight:700" : ""}">${[r.capLabel, usd(r.value), r.ppu != null ? usd(r.ppu) : "—", r.ppsf != null ? "$" + r.ppsf : "—", (r.deltaPct > 0 ? "+" : "") + r.deltaPct + "%"].map((v) => `<td style="padding:8px 9px;border-bottom:1px solid #ECEFF3">${v}</td>`).join("")}</tr>`).join("")}</tbody></table>`) : "";
  const priceOpinion = `<div style="position:relative;min-height:1040px;background:${BOV_NV};page-break-after:always">
    <div style="position:absolute;inset:16px;border:1px solid ${BOV_OR};pointer-events:none"></div>
    <div style="position:absolute;left:8%;right:8%;top:34%;background:rgba(16,28,47,.82);border:1px solid ${BOV_OR};padding:36px 30px;text-align:center">
      <div style="color:${BOV_OR};font-size:23px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px">Broker Opinion of Value</div>
      <div style="color:#fff;font-size:34px;letter-spacing:.01em;font-weight:700">${bovPrice ? usd(bovPrice) : uw?.asking_price ? usd(uw.asking_price) : "$ —"}</div>
      <div style="color:#B9C4D2;font-size:11px;margin-top:12px;line-height:1.6">${esc(priceNotes || "Reconciled from the income approach and the comparable-sales approach summarized in this book. Subject to the assumptions and limiting conditions stated herein.")}</div>
    </div></div>`;
  return cover + confidentiality + exec + compTable(soldComps, "Sales Comparables") + compTable(activeComps, "Active Listings") + sens + priceOpinion;
}

// --- Scout report (map lot grid) ---------------------------------------------
export function scoutReportHtml({ modeLabel, lots, mix, holders, topUnused }) {
  const gold = "#B08D42", navy = "#0E1F33";
  const unusedTotal = lots.reduce((n, l) => n + (l.unusedBsf || 0), 0);
  const individual = lots.filter((l) => l.ownerKind === "individual" || l.ownerKind === "trust").length;
  return `<style>
    .scout{font-family:Georgia,serif;color:${navy};max-width:760px;margin:0 auto;background:#fff;padding:32px}
    .scout .eyebrow{font:700 10px system-ui;letter-spacing:.18em;text-transform:uppercase;color:${gold}}
    .scout h1{font-size:26px;margin:6px 0 2px}.scout .sub{color:#5a6a7d;font-size:13px;margin-bottom:4px}
    .scout .kpis{display:flex;gap:14px;margin:18px 0;flex-wrap:wrap}
    .scout .kpi{flex:1;min-width:130px;border-top:3px solid ${gold};padding-top:8px}
    .scout .kpi .v{font-size:22px;font-weight:700}.scout .kpi .l{font:600 10px system-ui;letter-spacing:.08em;text-transform:uppercase;color:#5a6a7d}
    .scout h2{font:700 12px system-ui;letter-spacing:.14em;text-transform:uppercase;color:${navy};border-bottom:2px solid ${navy};padding-bottom:5px;margin:26px 0 8px}
    .scout table{width:100%;border-collapse:collapse;font-size:13px}.scout td{padding:5px 4px;border-bottom:1px solid #e4e8ee}
    .scout .foot{margin-top:28px;font-size:10px;color:#8a93a8;font-family:system-ui}
  </style>
  <div class="scout">
    <div class="eyebrow">NYC RE Market Intel · Lot Grid</div>
    <h1>Scout Report <span style="font:700 9px system-ui;letter-spacing:.1em;color:#fff;background:${gold};border-radius:3px;padding:2px 7px;vertical-align:middle">BETA</span></h1>
    <div class="sub">${esc(modeLabel)} · ${new Date().toLocaleString()}</div>
    <div class="kpis">
      <div class="kpi"><div class="v">${lots.length.toLocaleString()}</div><div class="l">Lots in view</div></div>
      <div class="kpi"><div class="v">${unusedTotal.toLocaleString()}</div><div class="l">Unused bsf</div></div>
      <div class="kpi"><div class="v">${individual.toLocaleString()}</div><div class="l">Individual / estate held</div></div>
      <div class="kpi"><div class="v">${holders.length}</div><div class="l">Multi-lot owners</div></div>
    </div>
    <h2>What's in view</h2><table>${mix.map((r) => `<tr><td><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${r.color};margin-right:7px"></i>${esc(r.label)}</td><td style="text-align:right">${r.n.toLocaleString()}</td></tr>`).join("")}</table>
    <h2>Deepest holders (2+ lots)</h2><table><tr><td style="font-weight:700">Owner</td><td style="font-weight:700">Type</td><td style="font-weight:700;text-align:right">Lots</td></tr>${holders.length ? holders.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.kind)}</td><td style="text-align:right">${o.n}</td></tr>`).join("") : `<tr><td colspan="3" style="color:#8a93a8">No owner holds more than one lot in this view.</td></tr>`}</table>
    <h2>Top unused buildable</h2><table><tr><td style="font-weight:700">Address</td><td style="font-weight:700">Zoning</td><td style="font-weight:700;text-align:right">Unused bsf</td><td style="font-weight:700;text-align:right">Restrictions</td></tr>${topUnused.map((l) => `<tr><td>${esc(l.address ?? l.bbl)}</td><td>${esc(l.zoning ?? "—")}</td><td style="text-align:right;font-weight:700">+${(l.unusedBsf || 0).toLocaleString()}</td><td style="text-align:right">${l.enc ? l.enc + " ⚠" : "clear"}</td></tr>`).join("")}</table>
    <div class="foot">Reflects the current map view and active filters only. Owner type is read from the roll name — a signal, not a legal determination. Unused buildable = max FAR × lot area − built area; not necessarily transferable.</div>
  </div>`;
}
