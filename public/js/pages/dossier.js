// Parcel Dossier — search any asset, get the whole story: imagery, KPIs,
// seller-propensity + distress breakdowns, tax cliffs, transit, violations,
// assemblage, tax history, story, sales/financing/permits/comps tables,
// owner portfolio, outreach drafting, canvass log, contacts, reports.
import { api, apiSend, invalidate, desk, saveDesk, deskName } from "../api.js";
import * as auth from "../auth.js";
import { el, els, h, kvRow, spinner, toast, pillBadge, bandBadge, sectionHead, openDocumentPreview, icons } from "../ui.js";
import { num, usd, dateShort, exportCsv } from "../lib/format.js";
import { govLinks, boroughOfBbl } from "../lib/constants.js";
import { propensityFor, storyParagraphs, outreachDraft, distressFromRecord } from "../lib/intel.js";
import { propertyReportHtml, marketReportHtml } from "../lib/reports.js";

export async function mount(root, { params }) {
  root.innerHTML = `<div class="scroll" style="height:100%"><div style="max-width:880px;margin:0 auto;padding:20px 18px 60px" id="dz"></div></div>`;
  const dz = el("#dz");
  const bbl = (params.get("bbl") ?? "").replace(/[^0-9]/g, "");
  renderSearch(dz, params.get("addr") ?? "");
  if (bbl.length === 10) loadRecord(dz, bbl, params.get("addr") ?? "");
  return {};
}

function renderSearch(dz, prefill) {
  dz.innerHTML = `
    <div class="eyebrow">Parcel Dossier</div>
    <h1 class="page-title">Search any asset. Get the whole story.</h1>
    <p class="sub" style="max-width:620px">Type an address or BBL — get imagery, usage, full sales & owner history, financing, permits, contacts, and the public-record links for that one parcel.</p>
    <div style="display:flex;gap:8px;margin:14px 0 6px">
      <input id="dz-q" class="field" placeholder="151 West 25 St, New York   ·   or a 10-digit BBL" value="${h(prefill)}" style="flex:1" />
      <button class="btn primary" id="dz-go">Open dossier</button>
    </div>
    <p class="note" id="dz-err"></p>
    <div id="dz-body">
      <div class="card" style="border-style:dashed;padding:36px;text-align:center;margin-top:14px">
        <p class="sub">Enter an address or BBL above to open a full parcel dossier. Or try one:</p>
        <div style="display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin-top:10px" id="dz-examples">${spinner("Loading examples…")}</div>
      </div>
    </div>`;
  const go = async () => {
    const q = el("#dz-q").value.trim();
    if (!q) return;
    el("#dz-err").textContent = "";
    el("#dz-go").disabled = true;
    try {
      const digits = q.replace(/[^0-9]/g, "");
      let target = digits.length === 10 ? { bbl: digits } : null;
      if (!target) {
        const r = await api(`/api/address?q=${encodeURIComponent(q)}`);
        const hit = r.buildings?.[0];
        if (hit?.bbl) target = { bbl: hit.bbl, addr: hit.address };
      }
      if (!target) { el("#dz-err").textContent = `Couldn't resolve "${q}". Try a fuller address or a 10-digit BBL.`; return; }
      window.location.hash = `#/dossier?bbl=${target.bbl}&addr=${encodeURIComponent(target.addr ?? "")}`;
    } finally { el("#dz-go").disabled = false; }
  };
  el("#dz-go").addEventListener("click", go);
  el("#dz-q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  api("/api/area-buildings?zips=11211,10001,11101&pageSize=3&sort=score").then((r) => {
    const ex = el("#dz-examples");
    if (ex) ex.innerHTML = r.buildings.map((b) => `<a class="chip" href="#/dossier?bbl=${b.bbl}&addr=${encodeURIComponent(b.address)}">${h(b.address)}</a>`).join("");
  }).catch(() => {});
}

async function loadRecord(dz, bbl, addrHint) {
  const body = el("#dz-body");
  body.innerHTML = `<div style="padding:26px 0">${spinner("Pulling the full public record…")}</div>`;
  let record;
  try { record = await api(`/api/asset-history?bbl=${bbl}`); }
  catch {
    body.innerHTML = `<div class="callout amber" style="margin-top:14px">No live record resolved for BBL ${h(bbl)}${addrHint ? ` (${h(addrHint)})` : ""} — expected for curated demo identifiers. Exact NYC lots resolve to the full record.</div>`;
    return;
  }
  const p = record.pluto ?? {};
  const prop = propensityFor({ yearBuilt: p.yearBuilt, builtFar: p.builtFar, maxFar: p.maxFar, lotArea: p.lotArea, owner: p.owner, unitsRes: p.unitsRes, assessLand: record.assessment?.assessLand, assessTotal: record.assessment?.assessTotal, permitCount: (record.permits ?? []).length });
  const [distress, cliffs, transit, taxHist, assemblage, similar, portfolio] = await Promise.all([
    api(`/api/distress?bbl=${bbl}`).catch(() => null),
    api(`/api/cliffs?bbl=${bbl}`).catch(() => null),
    api(`/api/transit?bbl=${bbl}`).catch(() => null),
    api(`/api/tax-history?bbl=${bbl}`).catch(() => null),
    api(`/api/assemblage?bbl=${bbl}`).catch(() => null),
    api(`/api/similar?bbl=${bbl}`).catch(() => null),
    p.owner ? api(`/api/owner-portfolio?owner=${encodeURIComponent(p.owner)}`).catch(() => null) : null
  ]);
  const sig = distressFromRecord(record);
  const links = govLinks(bbl, parseInt(bbl.slice(1, 6), 10), parseInt(bbl.slice(6), 10));
  const addr = record.address || addrHint || `BBL ${bbl}`;
  const comps = record.comps ?? [];
  const compMedian = median(comps.map((c) => c.ppsf).filter(Boolean));
  const inWatch = desk().watchlist.some((w) => w.bbl === bbl);
  const draft = outreachDraft({ address: addr, neighborhood: null, owner: p.owner, prop, sig, cliffs, metrics: record.metrics, assetLabel: "assets", preparedBy: deskName() });
  const bandColor = (b) => (b === "High" ? "var(--red)" : b === "Elevated" ? "var(--amber)" : b === "Watch" ? "#9a7400" : "var(--ink-faint)");

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:16px">
      <div><h2 style="margin:0;font-size:18px;font-weight:750">${h(addr)}</h2>
        <p class="note" style="margin-top:2px">BBL ${bbl}${p.zoning ? ` · ${h(p.zoning)}` : ""}${p.yearBuilt ? ` · built ${p.yearBuilt}` : ""}</p></div>
      <div style="display:flex;flex-wrap:wrap;gap:7px">
        <button class="btn primary" id="dz-report" title="Full internal report — distress, seller-propensity, owner outreach leads">${icons.file} Property report</button>
        <button class="btn ghost" id="dz-investor" title="Client-ready investor edition — asset, comps & market; no internal outreach or seller-propensity">${icons.file} Investor report</button>
        <a class="btn" title="Open the deal calculator pre-filled from this parcel" href="#/calculator?calcBbl=${bbl}&calcAddr=${encodeURIComponent(addr)}&calcSf=${p.bldgArea ?? ""}&calcUnits=${p.unitsRes ?? ""}&calcLot=${p.lotArea ?? ""}${record.metrics?.lastSalePrice ? `&calcPrice=${record.metrics.lastSalePrice}` : ""}">${icons.calc} Calculator</a>
        <button class="btn" id="dz-watch">${inWatch ? "★ Watching" : "☆ Watch"}</button>
        <button class="btn" id="dz-pipe">＋ Add to Pipeline</button>
        <button class="btn ghost" id="dz-mkt" title="Client-ready investment-sales report for this asset's surrounding market">${icons.chart} Market report</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
      <img style="width:100%;height:172px;object-fit:cover;border-radius:10px;border:1px solid var(--line);background:var(--bg-sunken)" alt="Street view" src="/api/streetview?bbl=${bbl}" onerror="this.style.display='none'" />
      <img style="width:100%;height:172px;object-fit:cover;border-radius:10px;border:1px solid var(--line);background:var(--bg-sunken)" alt="Aerial" src="/api/staticmap?bbl=${bbl}&size=640x360" onerror="this.style.display='none'" />
    </div>
    <div class="statgrid" style="margin-top:12px">
      ${stat(record.metrics?.lastSalePrice ? usd(record.metrics.lastSalePrice) : "—", "Last sale", record.metrics?.lastSaleDate ? String(record.metrics.lastSaleDate).slice(0, 4) : "no recorded price")}
      ${stat(record.metrics?.lastSalePpsf ? usd(record.metrics.lastSalePpsf) : "—", "Last sale $/sf", "price ÷ built sf")}
      ${stat(record.metrics?.holdYears != null ? `${record.metrics.holdYears} yrs` : "—", "Hold period", "since last deed")}
      ${stat(compMedian ? usd(compMedian) : "—", "Comp median $/sf", "same ZIP + class, 24-mo")}
    </div>

    ${p.mailAddress ? `<div class="callout blue" style="margin-top:10px;padding:9px 13px">
      <p class="eyebrow" style="margin:0;color:var(--accent-ink)">Absentee owner</p>
      <p style="margin:2px 0 0;font-size:12.5px;font-weight:600">Mails to ${h(p.mailAddress)}</p>
    </div>` : ""}

    ${sectionHead("Seller-propensity — breakdown & how to verify", "Beta · every input is a live public-record pull you can confirm")}
    ${prop.excluded ? `<div class="card card-pad note">${h(prop.excluded)}</div>` : `
      <div class="callout" style="border-color:${bandColor(prop.band)};background:color-mix(in oklab, ${prop.band === "High" ? "var(--red)" : prop.band === "Elevated" ? "var(--amber)" : "var(--accent)"} 8%, transparent)">
        <div style="display:flex;justify-content:space-between"><b>Composite seller-propensity</b><b class="tabular" style="color:${bandColor(prop.band)}">${prop.band} · ${prop.score}/100</b></div>
        <p class="note" style="margin:4px 0 0">${prop.components.length ? `${prop.components.length} signal${prop.components.length === 1 ? "" : "s"} fired — they sum to ${prop.score} (capped at 100). Each line below cites the exact dataset + field so you can confirm it live before positioning.` : "No seller signals fired on the public record — a relationship / timing play rather than a pressure play."}</p>
      </div>
      ${prop.components.length ? `<div class="table-wrap card" style="margin-top:8px"><table class="tbl">
        <thead><tr><th>Signal</th><th>Pts</th><th>What the record shows — verify</th><th>Source (dataset · field)</th></tr></thead>
        <tbody>${prop.components.map((c) => `<tr><td><b>${h(c.label)}</b></td><td class="r" style="color:var(--accent-ink);font-weight:700">+${c.points}</td><td style="font-size:11.5px">${h(c.detail)}</td><td class="note">${h(c.source)}</td></tr>`).join("")}
        <tr style="border-top:2px solid var(--line)"><td><b>Composite score</b></td><td class="r"><b>${prop.score}</b></td><td class="note" colspan="2">Sum of the signals above, capped at 100. Bands: High ≥ 55, Elevated ≥ 35, Watch ≥ 18.</td></tr></tbody></table></div>` : ""}
      <div class="callout blue" style="margin-top:8px;font-size:11.5px"><b>How to read it (and the edge most miss):</b> this is a transparent, additive model — no black box. It reads the City's <b>own</b> assessment split (land vs. building) to flag teardown economics, quantifies <b>unused air rights in square feet</b>, and pairs with the <b>abatement burn-off</b> and <b>LL97 2030 carbon penalty</b> below — the dated, forced events that reset an asset's carry and that almost no competitor prices in. It ranks <i>where to spend outreach</i>, not a guarantee of a sale; every number is verifiable against the cited public source.</div>`}

    ${sectionHead("Distress & debt-maturity signals", "motivated-seller score · debt timing · public-record stack")}
    <div class="callout" style="border-color:${bandColor(sig.band)}">
      <div style="display:flex;justify-content:space-between"><b>Motivated-seller profile</b><b class="tabular" style="color:${bandColor(sig.band)}">${sig.band} · ${sig.distressScore}/100</b></div>
      <p class="note" style="margin:4px 0 0">${h(sig.summary)}</p>
    </div>
    ${sig.debt ? `<div class="card card-pad" style="margin-top:8px;padding:10px 13px">
      <p class="eyebrow dim" style="margin:0 0 4px">Debt maturity (estimated)</p>
      <p style="margin:0;font-size:12.5px"><b>$${num(sig.debt.amount)}</b> from ${h(sig.debt.lender)} · recorded ${String(sig.debt.date).slice(0, 4)} ·
        <span style="color:${sig.debt.status === "past" ? "var(--red)" : sig.debt.status === "approaching" ? "var(--amber)" : "var(--ink-faint)"};font-weight:${sig.debt.status === "seasoned" ? 400 : 700}">
        ${sig.debt.status === "past" ? `past est. maturity (~${sig.debt.estMaturityYear})` : sig.debt.status === "approaching" ? `maturing ~${sig.debt.estMaturityYear}` : `est. maturity ~${sig.debt.estMaturityYear}`}</span></p>
      <p class="note" style="margin:4px 0 0">${h(sig.debt.note)}</p></div>` : ""}
    ${sig.reasons.length ? `<div style="display:grid;gap:5px;margin-top:8px">${sig.reasons.map((r) => `<div class="card" style="padding:8px 12px"><div style="display:flex;justify-content:space-between;font-size:11.5px"><b>${h(r.label)}</b><b style="color:var(--accent-ink)">+${r.weight}</b></div><p class="note" style="margin:3px 0 0">${h(r.detail)}</p></div>`).join("")}</div>` : ""}
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:9px" id="dz-checks">
      <button class="btn sm ghost" id="dz-lien" title="NYC tax & water lien-sale lookup">NYC tax &amp; water lien sale</button>
      <a class="btn sm" href="https://iapps.courts.state.ny.us/nyscef/CaseSearch?TAB=name" target="_blank" rel="noopener">Lis pendens / foreclosure (NYSCEF) ${icons.external}</a>
      <a class="btn sm" href="${links.acris}" target="_blank" rel="noopener">Recorded cap stack ${icons.external}</a>
    </div>
    <p class="note" style="margin-top:6px">Debt maturity is estimated from the recorded mortgage date (NYC doesn't publish loan terms); a stacked distress profile typically precedes a lis pendens filing, so this is the early warning.</p>

    ${cliffs && (cliffs.j51 || cliffs.ll97 || cliffs.ll33) ? `
      ${sectionHead("Tax & regulatory cliffs", "dated forced events most buyers don't price in")}
      <div style="display:grid;gap:7px">
        ${cliffs.j51 ? `<div class="callout ${cliffs.j51.status === "expiring" ? "amber" : "blue"}"><b>J-51 abatement</b> — ${cliffs.j51.exYears}-yr exemption from ${cliffs.j51.initYear}, ${cliffs.j51.status === "expired" ? `already <b>burned off (~${cliffs.j51.endYear})</b> — taxes have stepped up.` : cliffs.j51.status === "expiring" ? `<b style="color:var(--amber)">burns off ~${cliffs.j51.endYear} — tax step-up imminent.</b>` : `runs through ~<b>${cliffs.j51.endYear}</b>; taxes rise when it ends.`}</div>` : ""}
        ${cliffs.ll97 ? `<div class="callout ${cliffs.ll97.status === "exposed" ? "red" : "green"}"><b>Local Law 97 (2030)</b> — ${h(cliffs.ll97.type)}, ${cliffs.ll97.ghg.toLocaleString()} tCO₂e vs ~${cliffs.ll97.capTons.toLocaleString()} t cap. ${cliffs.ll97.status === "exposed" ? `<b style="color:var(--red)">~$${cliffs.ll97.penalty2030.toLocaleString()}/yr estimated penalty starting 2030 (${cliffs.ll97.overTons.toLocaleString()} t over).</b>` : `<b style="color:var(--green)">projected compliant at the 2030 cap.</b>`}<p class="note" style="margin:4px 0 0">From LL84 benchmarking (${cliffs.ll97.reportYear}). Penalty = tons over the 2030 cap × $268/t — a labeled estimate; confirm with an energy audit.</p></div>` : ""}
        ${cliffs.ll33 ? `<div class="callout ${["A", "B"].includes(cliffs.ll33.grade) ? "green" : cliffs.ll33.grade === "C" ? "amber" : "red"}"><b>Local Law 33 energy grade</b> — <b>${cliffs.ll33.grade}</b>${cliffs.ll33.score != null ? ` (ENERGY STAR score ${cliffs.ll33.score})` : ""}. ${["A", "B"].includes(cliffs.ll33.grade) ? "Efficient — low carbon-penalty exposure." : cliffs.ll33.grade === "C" ? "Middling — partial LL97 exposure likely." : cliffs.ll33.grade === "N" ? "Exempt / not rated." : "Poor — the publicly-posted grade signals retrofit cost and LL97 risk."}<p class="note" style="margin:4px 0 0">The letter grade posted at the building entrance (LL33). Buildings >25,000 sf. A=85+, B=70–84, C=55–69, D=<55.</p></div>` : ""}
      </div>
      <p class="note" style="margin-top:6px">These are the dated economic events that reset an asset's carry — an abatement burning off (tax jumps) or LL97 carbon penalties beginning 2030. Most buyers underwrite today's numbers and miss them; that's the negotiating lever.</p>` : ""}

    ${transit?.nearest ? `${sectionHead("Transit proximity", "walk-up to subway — a rent / cap-rate / demand driver")}
      <div class="card card-pad" style="padding:11px 14px">
        <p style="margin:0;font-size:12.5px"><b>${h(transit.nearest.name)}</b>${transit.nearest.lines ? ` (${h(transit.nearest.lines)})` : ""} — <b>${transit.nearest.distanceFt.toLocaleString()} ft</b> away (~${Math.max(1, Math.round(transit.nearest.distanceFt / 264) / 10)} mi).</p>
        <p class="note" style="margin:4px 0 0">${transit.within.quarterMile} station${transit.within.quarterMile === 1 ? "" : "s"} within ¼ mi · ${transit.within.halfMile} within ½ mi. Source: public transit records.</p>
      </div>` : ""}

    ${distress ? `${sectionHead("Distress — live public records", "open violations, unpaid fines & complaint volume — verifiable cold-call hooks")}
      <div class="statgrid">
        ${stat(`${distress.hpd?.open ?? 0}<span style="font-size:11px;font-weight:400;color:var(--ink-faint)"> open / ${distress.hpd?.total ?? 0} all-time</span>`, "Housing violations", distress.hpd?.heatOpen ? `${distress.hpd.heatOpen} heat / hot-water open` : "", distress.hpd?.open >= 10 ? "gold" : "")}
        ${stat(`$${num(distress.ecb?.balanceDue ?? 0)}`, "Building fines", `${distress.ecb?.unresolved ?? 0} unresolved case${(distress.ecb?.unresolved ?? 0) === 1 ? "" : "s"}`, distress.ecb?.balanceDue >= 5e4 ? "gold" : "")}
        ${stat(String(distress.threeOneOne?.total12mo ?? 0), "311 (last 12 mo)", distress.threeOneOne?.heatHotWater12mo ? `${distress.threeOneOne.heatHotWater12mo} heat / hot-water` : "")}
      </div>
      ${distress.threeOneOne?.topCategories?.length ? `<p class="note" style="margin-top:6px">Top 311 categories: ${distress.threeOneOne.topCategories.map((c) => `${h(c.type)} (${c.n})`).join(" · ")}</p>` : ""}` : ""}

    ${assemblage && (assemblage.count > 1 || (assemblage.subjectUnusedSf ?? 0) >= 2000) ? `
      ${sectionHead("Assemblage & air-rights", "same-owner lots on this block · unused development rights")}
      <div class="statgrid">
        ${stat(assemblage.subjectUnusedSf != null ? `${num(assemblage.subjectUnusedSf)} sf` : "—", "This lot — unused FAR", "")}
        ${stat(String(assemblage.count), "Same-owner lots on block", "", assemblage.count > 1 ? "gold" : "")}
        ${stat(assemblage.totalUnusedSf ? `${num(assemblage.totalUnusedSf)} sf` : "—", "Combined unused FAR", "", assemblage.totalUnusedSf >= 1e4 ? "gold" : "")}
      </div>
      ${assemblage.count > 1 ? `<div class="table-wrap card" style="margin-top:8px"><table class="tbl"><thead><tr><th>Lot</th><th class="r">Lot area</th><th class="r">Built FAR</th><th class="r">Max FAR</th><th class="r">Unused SF</th><th></th></tr></thead>
        <tbody>${assemblage.lots.map((l) => `<tr><td>${h(l.address)}</td><td class="r">${num(l.lotArea)}</td><td class="r">${l.builtFar ?? "—"}</td><td class="r">${l.maxFar ?? "—"}</td><td class="r">${l.unusedSf != null ? num(l.unusedSf) : "—"}</td><td><a href="#/dossier?bbl=${l.bbl}&addr=${encodeURIComponent(l.address || "")}">→</a></td></tr>`).join("")}</tbody></table></div>` : ""}
      <p class="note" style="margin-top:6px">${assemblage.owner ? `<b>${h(assemblage.owner)}</b> holds ${assemblage.count} lot${assemblage.count === 1 ? "" : "s"} on this block` : "Owner of record"} with ~${num(assemblage.totalUnusedSf)} sf of unused as-of-right floor area. Contiguous same-owner underbuilt lots = an assemblage / air-rights play.</p>` : ""}

    ${taxHist?.rows?.length ? `${sectionHead("Assessment & tax history", "multi-year market value, assessed, taxable & estimated tax")}
      <div class="table-wrap card"><table class="tbl"><thead><tr><th>Year</th><th class="r">Full market value</th><th class="r">Assessed (local roll)</th><th class="r">Taxable</th><th class="r">Est. tax</th><th class="r">YoY mkt</th></tr></thead>
      <tbody>${taxHist.rows.map((r) => `<tr><td>${r.year}${r.taxClass ? ` · cl ${r.taxClass}` : ""}</td><td class="r">$${num(r.marketValue)}</td><td class="r">$${num(r.assessedTotal)}</td><td class="r">$${num(r.taxable)}</td><td class="r">$${num(r.estTax)}</td><td class="r" style="color:${r.yoyMarketPct == null ? "inherit" : r.yoyMarketPct >= 0 ? "var(--green)" : "var(--red)"}">${r.yoyMarketPct == null ? "—" : `${r.yoyMarketPct >= 0 ? "+" : ""}${r.yoyMarketPct}%`}</td></tr>`).join("")}</tbody></table></div>
      <p class="note" style="margin-top:6px">Live from official city assessment records. <b>Estimated tax</b> = taxable × the year's statutory class rate (actual billed can differ with transitional assessed value or abatements). Assessed values aren't comparable between municipalities — each sets its own equalisation rate. Full market value is the normalised figure.</p>` : ""}

    ${storyParagraphs(record).length ? `${sectionHead("The story", "synthesized from the live record")}
      <div class="card card-pad">${storyParagraphs(record).map((s) => `<p style="font-size:13px;line-height:1.65;margin:0 0 9px">${h(s)}</p>`).join("")}</div>` : ""}

    ${sectionHead("Usage & physical", "public record")}
    <div class="card card-pad" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0 22px">
      ${kvRow("Built", p.yearBuilt ? String(p.yearBuilt) : "—")}${kvRow("Altered", p.yearAlter1 ? String(p.yearAlter1) : "—")}
      ${kvRow("Land use", h(p.landUse ?? "—"))}${kvRow("Bldg class", h(p.bldgClass ?? "—"))}${kvRow("Zoning", h(p.zoning ?? "—"))}
      ${kvRow("Resi / total units", `${num(p.unitsRes)} / ${num(p.unitsTotal)}`)}${kvRow("Lot / bldg sf", `${num(p.lotArea)} / ${num(p.bldgArea)}`)}
      ${kvRow("Built / max FAR", `${(p.builtFar ?? 0).toFixed(1)} / ${(p.maxFar ?? 0).toFixed(1)}`)}${kvRow("Floors", num(p.numFloors))}
      ${kvRow("Owner (current)", h(p.owner ?? "—"))}
    </div>

    ${sectionHead("Sales & owner history", "recorded deeds — as far back as records allow")}
    ${tableCard(["Recorded", "Price", "Seller", "Buyer"], (record.sales ?? []).map((s) => [dateShort(s.date), s.amount > 0 ? usd(s.amount) : "—", h(s.grantor), h(s.grantee)]), "No recorded deeds found for this lot.")}
    ${sectionHead("Financing history", "recorded mortgages & assignments")}
    ${(record.loans ?? []).length
      ? tableCard(["Recorded", "Amount", "Type", "Lender / counterparty"], record.loans.map((l) => [dateShort(l.date), l.amount > 0 ? usd(l.amount) : "—", h(l.docType), h(l.lender)]), "")
      : `<div class="card card-pad note">No recorded mortgage on file — likely owned free &amp; clear or held via an unrecorded structure.</div>`}
    ${sectionHead("Comparable sales nearby", "same ZIP + building-class family · last 24 months")}
    ${tableCard(["Sale date", "Address", "Class", "Price", "$/sf"], comps.map((c) => [dateShort(c.date), c.bbl ? `<a href="#/dossier?bbl=${c.bbl}&addr=${encodeURIComponent(c.address)}">${h(c.address)}</a>` : h(c.address), h(c.bldgClass), usd(c.price), c.ppsf ? usd(c.ppsf) : "—"]), "No comparable sales found in the window.")}
    ${sectionHead("Permit / work history", "public record")}
    ${tableCard(["Date", "Type", "Status", "Applicant"], (record.permits ?? []).slice(0, 25).map((x) => [dateShort(x.date), h(x.type), h(x.status), h(x.applicant)]), "No permit history found.")}

    ${portfolio && portfolio.total >= 2 ? `${sectionHead("Owner portfolio (citywide)", "what else this owner-of-record holds")}
      <p style="font-size:12.5px;margin:0 0 7px"><b>${h(portfolio.owner)}</b> holds <b>${portfolio.total}</b> lots citywide${portfolio.units ? ` · <b>${num(portfolio.units)}</b> residential units` : ""} under this exact owner name — a portfolio-level conversation, not a one-off.</p>
      ${tableCard(["Address", "Class", "Units", "ZIP", ""], portfolio.sample.slice(0, 15).map((x) => [h(x.address), h(x.bldgClass || "—"), x.unitsRes ?? "—", h(x.zip || "—"), `<a href="#/dossier?bbl=${x.bbl}">Dossier →</a>`]), "")}
      <p class="note" style="margin-top:5px">Matched on the exact owner-of-record name (live). Owners who hold each building in a separate single-purpose LLC will show fewer here.</p>` : ""}

    ${sectionHead("Draft outreach", "Beta · in your voice · copy & send yourself (never auto-sent)")}
    <div class="card card-pad">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <div class="pill-toggle"><button class="on" data-draft="email">Email</button><button data-draft="letter">Letter</button></div>
        <button class="btn sm ghost" id="dz-copy">Copy</button>
        <span class="note" id="dz-subject">Subject: <b>${h(draft.subject)}</b></span>
      </div>
      <pre id="dz-draft" style="white-space:pre-wrap;font-family:inherit;font-size:12.5px;line-height:1.6;background:var(--bg-sunken);border:1px solid var(--line);border-radius:9px;padding:12px;margin:0">${h(draft.email)}</pre>
      <p class="note" style="margin-top:7px">Drafted from this parcel's strongest why-now signal. Review, personalize, and send from your own email/mail — the app never sends on your behalf. Set your name in the sidebar.</p>
    </div>

    ${sectionHead("Marketing check", "is it listed publicly right now?")}
    <div class="card card-pad" id="dz-marketing"><button class="btn sm ghost" id="dz-mkt-check">Run a live check</button>
      <span class="note" style="margin-left:9px">Searches the listing platforms for this exact address.</span></div>

    <div id="dz-investor-match"></div>
    <div id="dz-xref"></div>

    ${sectionHead("Canvass log", "your private touch history on this parcel — calls, doors, emails, meetings")}
    <div class="card card-pad" id="dz-canvass"></div>

    ${similar?.configured ? `${sectionHead("Similar properties", "profile similarity across the demo universe")}
      ${similar.matches?.length
        ? tableCard(["Address", "Class", "ZIP", "Match", ""], similar.matches.map((m) => [h(m.address || m.bbl), h(m.bldgclass || "—"), h(m.zip || "—"), m.score != null ? `${Math.round(m.score * 100)}%` : "—", `<a href="#/dossier?bbl=${m.bbl}&addr=${encodeURIComponent(m.address || "")}">Dossier →</a>`]), "")
        : `<div class="card card-pad note">No similar assets indexed yet — the index grows as you open more parcels. Check back after browsing a few.</div>`}` : ""}

    ${sectionHead("Open official records", "live, this exact lot")}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:7px">
      ${[["NYC Property Information Portal", links.propPortal], ["Recorded documents — deeds, mortgages, parties", links.acris], ["Buildings records — permits, jobs, violations", links.bisweb], ["Zoning map — zoning, overlays, flood", links.zola], ["PropertyShark — tax, owner, docs, permits", `https://www.propertyshark.com/mason/Property-Search?searchText=${encodeURIComponent(addr)}`], ["NY AG offering-plan database (condo/co-op)", "https://offeringplan.datasearch.ag.ny.gov/REF/"]]
        .map(([l, u]) => `<a class="card" style="padding:10px 13px;display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:600" href="${u}" target="_blank" rel="noopener">${h(l)} ${icons.external}</a>`).join("")}
    </div>`;

  // Wire actions
  el("#dz-report").addEventListener("click", async () => {
    const lien = await api(`/api/liensale?bbl=${bbl}`).catch(() => null);
    openDocumentPreview("Property Report", propertyReportHtml({ record, propensity: prop, distress: sig, cliffs, lien, preparedBy: deskName() || "NYC RE Market Intel", mode: "internal" }));
  });
  el("#dz-investor").addEventListener("click", () => {
    openDocumentPreview("Investor Report", propertyReportHtml({ record, propensity: prop, distress: sig, cliffs, lien: null, preparedBy: deskName() || "NYC RE Market Intel", mode: "investor" }));
  });
  el("#dz-mkt").addEventListener("click", async () => {
    const zip = p.zip;
    if (!zip) return toast("Couldn't resolve a ZIP for this parcel.");
    const [report, radar] = await Promise.all([
      api(`/api/market-report?zips=${zip}`),
      api(`/api/area-buildings?zips=${zip}&sort=propensity&pageSize=8`).then((r) => r.buildings.filter((b) => (b.propensity ?? 0) >= 18)).catch(() => [])
    ]);
    openDocumentPreview("Market Report", marketReportHtml({ label: `ZIP ${zip}`, zips: [zip], borough: boroughOfBbl(bbl), assetClass: "multifamily", report, radar }));
  });
  el("#dz-watch").addEventListener("click", async () => {
    if (!auth.isSignedIn()) return toast("Sign in (left sidebar) to save your watchlist — it's private to your account.");
    const d = desk();
    const i = d.watchlist.findIndex((w) => w.bbl === bbl);
    try {
      if (i >= 0) {
        await fetch(`/api/watchlist/${bbl}`, { method: "DELETE" });
        d.watchlist.splice(i, 1);
        el("#dz-watch").textContent = "☆ Watch";
      } else {
        await apiSend("/api/watchlist", "POST", { bbl, address: addr });
        d.watchlist.unshift({ bbl, address: addr, added: Date.now() });
        el("#dz-watch").textContent = "★ Watching";
      }
      saveDesk(d); // browser copy is a cache of the account record
    } catch { toast("Could not save — try again."); }
  });
  el("#dz-pipe").addEventListener("click", async () => {
    if (!auth.isSignedIn()) return toast("Sign in (left sidebar) to use the pipeline — it's private to your account.");
    try {
      await apiSend("/api/pipeline", "POST", { bbl, address: addr, owner: p.owner ?? null, stage: "Lead", propensity: prop.score, assessed: record.assessment?.assessTotal ?? null, lastSale: record.metrics?.lastSalePrice ?? null });
      const d = desk();
      if (!d.pipeline.some((x) => x.bbl === bbl)) {
        d.pipeline.unshift({ bbl, address: addr, owner: p.owner ?? null, stage: "Lead", propensity: prop.score, assessed: record.assessment?.assessTotal ?? null, lastSale: record.metrics?.lastSalePrice ?? null, added: Date.now() });
        saveDesk(d);
      }
      toast("Added to pipeline ✓ — see My Desk");
    } catch { toast("Could not save — try again."); }
  });
  el("#dz-lien").addEventListener("click", async () => {
    el("#dz-lien").disabled = true;
    try {
      const lien = await api(`/api/liensale?bbl=${bbl}`, { fresh: true });
      el("#dz-checks").insertAdjacentHTML("beforeend", lien.onList
        ? `<div class="callout red" style="width:100%"><b>On the lien-sale list</b> — ${lien.records.length} entr${lien.records.length === 1 ? "y" : "ies"}; latest ${String(lien.records[0].month).slice(0, 7)} (${h(lien.records[0].cycle)}${lien.records[0].waterOnly ? ", water-only" : ""}). Direct tax/water distress signal.</div>`
        : `<div class="callout green" style="width:100%">Not on the published lien-sale list — no tax/water lien-sale exposure on record.</div>`);
    } finally { el("#dz-lien").disabled = false; }
  });
  let draftMode = "email";
  els("[data-draft]").forEach((b) => b.addEventListener("click", () => {
    draftMode = b.dataset.draft;
    els("[data-draft]").forEach((x) => x.classList.toggle("on", x === b));
    el("#dz-draft").textContent = draftMode === "email" ? draft.email : draft.letter;
    el("#dz-subject").style.display = draftMode === "email" ? "" : "none";
  }));
  el("#dz-copy").addEventListener("click", () => {
    navigator.clipboard?.writeText(draftMode === "email" ? `Subject: ${draft.subject}\n\n${draft.email}` : draft.letter);
    toast("Copied");
  });
  renderCanvass(bbl, addr);
  wireMarketingCheck(bbl, addr);
  renderInvestorMatch(bbl, addr, p, record);
  renderXref(bbl);
  wireObsidian(bbl, addr, p, record, prop, sig);
}

// Marketing check (audit gap): live listing detection when SERPER_API_KEY is
// set; honest off-state with one-click manual searches otherwise.
function wireMarketingCheck(bbl, addr) {
  el("#dz-mkt-check")?.addEventListener("click", async () => {
    const box = el("#dz-marketing");
    box.innerHTML = `<p class="note" style="margin:0">Searching public listings…</p>`;
    try {
      const lc = await api(`/api/listing-check?addr=${encodeURIComponent(addr)}&boro=${encodeURIComponent(boroughOfBbl(bbl) ?? "")}`, { fresh: true });
      if (lc.configured === false) {
        box.innerHTML = `<p class="note" style="margin:0 0 7px">Listing check off — add the SERPER_API_KEY secret to enable.</p>
          <div style="display:flex;flex-wrap:wrap;gap:5px">${(lc.searches ?? []).slice(0, 6).map((s) => `<a class="chip" style="font-size:10.5px;padding:3px 9px" href="${s.url}" target="_blank" rel="noopener">${h(s.label)} ${icons.external}</a>`).join("")}</div>`;
        return;
      }
      if (lc.error) { box.innerHTML = `<div class="callout amber" style="margin:0">Listing check failed: ${h(lc.error)}</div>`; return; }
      box.innerHTML = lc.forSale
        ? `<div class="callout red" style="margin:0"><b style="color:var(--red)">LISTING</b> — Appears to be marketed publicly — listing-platform hits below.
            ${(lc.hits ?? []).map((x) => `<a style="display:block;margin-top:5px;font-size:11.5px" href="${x.url}" target="_blank" rel="noopener">${h(x.source)}: ${h(x.title)} <span class="note">(${Math.round((x.confidence ?? 0) * 100)}% match)</span></a>`).join("")}</div>`
        : `<div class="callout green" style="margin:0">No active listing found on the major platforms${lc.hits?.length ? ` — nearest hits below the confidence bar:` : "."}
            ${(lc.hits ?? []).slice(0, 3).map((x) => `<a style="display:block;margin-top:5px;font-size:11.5px" href="${x.url}" target="_blank" rel="noopener">${h(x.source)}: ${h(x.title)}</a>`).join("")}
            <p class="note" style="margin:6px 0 0">${h(lc.expiresNote ?? "")}${lc.cached ? " (cached result)" : ""}</p></div>`;
    } catch { box.innerHTML = `<div class="callout amber" style="margin:0">Listing check failed — try again.</div>`; }
  });
}

// Investor match (audit item 28): the parcel auto-matched against the
// owner's private buy-box pool with fit %, gaps, contact actions and a BD
// angle. Owner-only — anonymous and non-owner accounts see nothing.
async function renderInvestorMatch(bbl, addr, p, record) {
  const box = el("#dz-investor-match");
  if (!box) return;
  let pool;
  try { pool = (await api("/api/investors", { fresh: true })).investors ?? []; }
  catch { box.innerHTML = ""; return; } // 401/403 — not the owner
  const { matchInvestors, bdAngle } = await import("../lib/investor-match.js");
  const matches = matchInvestors(pool, {
    borough: boroughOfBbl(bbl), bldgClass: p.bldgClass,
    price: record.metrics?.lastSalePrice ?? record.assessment?.assessTotal ?? null,
    units: p.unitsRes ?? null
  });
  const strong = matches.filter((m) => m.fit || m.score >= 0.6);
  const angle = bdAngle(matches, { address: addr });
  box.innerHTML = `
    ${sectionHead("Investor match", "private · auto-matched to your buy-box pool + BD angle")}
    <div class="card card-pad">
      ${pool.length === 0 ? `<p class="note" style="margin:0">No buy boxes yet. <a href="#/investors">Manage buy-box pool →</a></p>` : `
        ${strong.length ? `<p class="eyebrow dim" style="margin:0 0 5px">Fits your buyers</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${strong.slice(0, 5).map((m) => `
            <span class="badge" style="background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line);padding:5px 10px" title="${h(m.reasons.join(", "))}">
              ${h(m.investor.name || m.investor.firm || "—")} ${m.fit ? "✓" : `${Math.round(m.score * 100)}%`}
            </span>`).join("")}</div>
          <div style="display:grid;gap:5px;margin-top:9px">${strong.slice(0, 3).map((m) => `
            <div class="kv"><span class="k">${h(m.investor.name || "—")}${m.investor.firm ? ` · ${h(m.investor.firm)}` : ""}${m.gaps.length ? `<span class="note" style="display:block">Gaps: ${h(m.gaps.join("; "))}</span>` : ""}</span>
            <span class="v">${m.investor.phone ? `<a href="tel:${h(m.investor.phone)}" class="btn sm">Call</a>` : ""} ${m.investor.email ? `<a href="mailto:${h(m.investor.email)}?subject=${encodeURIComponent(addr)}" class="btn sm">Email</a>` : ""}</span></div>`).join("")}</div>`
        : `<p class="note" style="margin:0">No buy box in your pool fits this parcel${matches[0]?.gaps?.length ? ` — closest miss: ${h(matches[0].investor.name || "—")} (${h(matches[0].gaps.join("; "))})` : ""}.</p>`}
        ${angle ? `<div class="callout blue" style="margin-top:9px"><p class="eyebrow" style="margin:0 0 3px">BD angle</p><p style="margin:0;font-size:12px">${h(angle)}</p></div>` : ""}
        <a style="display:inline-block;margin-top:9px;font-size:11px;font-weight:650" href="#/investors">Manage buy-box pool →</a>`}
    </div>`;
}

// CRM cross-reference (audit item 29): owner-only Airtable seller/buyer
// relationships for this parcel; honest unconfigured and error states.
async function renderXref(bbl) {
  const box = el("#dz-xref");
  if (!box) return;
  let x;
  try { x = await api(`/api/airtable-xref?bbl=${bbl}`, { fresh: true }); }
  catch { box.innerHTML = ""; return; } // 401/403 — not the owner
  const list = (title, rows) => `
    <div><p class="eyebrow dim" style="margin:0 0 4px">${title}</p>
      ${rows.length ? rows.map((r) => `<div class="card" style="padding:7px 10px;font-size:11.5px;margin-bottom:4px"><b>${h(r.name)}</b></div>`).join("") : `<p class="note" style="margin:0">No matches.</p>`}
    </div>`;
  box.innerHTML = `
    ${sectionHead("CRM cross-reference", "your seller relationships & buyer fits — from your CRM")}
    <div class="card card-pad">
      ${x.configured === false
        ? `<p class="note" style="margin:0">${h(x.note ?? "Connect the CRM to enable the cross-reference.")}</p>`
        : `${x.errors?.length ? `<div class="callout amber" style="margin-bottom:8px">${h(x.errors.join(" · "))}</div>` : ""}
           <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
             ${list("Seller relationships", x.sellerMatches ?? [])}
             ${list("Buyer fits", x.buyerMatches ?? [])}
           </div>
           ${x.matchedOn?.length ? `<p class="note" style="margin:8px 0 0">Matched on: ${h(x.matchedOn.join(" · "))}</p>` : ""}`}
    </div>`;
}

// Add to Obsidian (audit item 30): owner-only markdown note with YAML
// frontmatter, parcel metadata and internal [[links]].
async function wireObsidian(bbl, addr, p, record, prop, sig) {
  try { await api("/api/pinecone-status", { fresh: true }); } catch { return; } // owner-gated probe
  const actions = el("#dz-report")?.parentElement;
  if (!actions || el("#dz-obsidian")) return;
  const btn = document.createElement("button");
  btn.className = "btn ghost";
  btn.id = "dz-obsidian";
  btn.title = "Owner only — download an Obsidian note (linked to owner + submarket) for your knowledge graph / Pinecone corpus";
  btn.innerHTML = `${icons.file} Add to Obsidian`;
  actions.appendChild(btn);
  btn.addEventListener("click", () => {
    const today = new Date().toISOString().slice(0, 10);
    const md = `---
bbl: "${bbl}"
address: "${addr}"
borough: "${boroughOfBbl(bbl) ?? ""}"
zip: "${p.zip ?? ""}"
zoning: "${p.zoning ?? ""}"
bldg_class: "${p.bldgClass ?? ""}"
units_res: ${p.unitsRes ?? 0}
lot_sf: ${p.lotArea ?? 0}
bldg_sf: ${p.bldgArea ?? 0}
built_far: ${p.builtFar ?? 0}
max_far: ${p.maxFar ?? 0}
owner: "${(p.owner ?? "").replace(/"/g, "'")}"
last_sale: ${record.metrics?.lastSalePrice ?? 0}
last_sale_date: "${record.metrics?.lastSaleDate ?? ""}"
propensity: ${prop?.score ?? 0}
distress: ${sig?.distressScore ?? 0}
captured: "${today}"
tags: [parcel, nyc]
---

# ${addr}

- Owner: [[${(p.owner ?? "Unknown owner").replace(/[[\]|#^]/g, " ")}]]
- Submarket: [[${p.zip ? `ZIP ${p.zip}` : boroughOfBbl(bbl) ?? "NYC"}]]
- Zoning: ${p.zoning ?? "—"} · Class ${p.bldgClass ?? "—"} · ${p.unitsRes ?? 0} resi units
- FAR ${p.builtFar ?? "—"} of ${p.maxFar ?? "—"}${p.maxFar > p.builtFar ? ` · ${Math.round(((p.maxFar - p.builtFar) * (p.lotArea ?? 0))).toLocaleString()} sf unused` : ""}
- Last sale: ${record.metrics?.lastSalePrice ? `$${record.metrics.lastSalePrice.toLocaleString()} (${record.metrics.lastSaleDate})` : "no recorded price"}
- Seller propensity ${prop?.score ?? "—"}/100 · distress ${sig?.distressScore ?? "—"}/100

## Why it's in the graph
${(storyParagraphs(record) ?? []).slice(0, 2).join("\n\n") || "Captured from the parcel dossier."}
`;
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${addr.replace(/[^a-z0-9]+/gi, " ").trim().replace(/\s+/g, " ")} — ${bbl}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Obsidian note downloaded");
  });
}

async function renderCanvass(bbl, addr) {
  const box = el("#dz-canvass");
  if (!auth.isSignedIn()) {
    box.innerHTML = `<p class="note" style="margin:0">Sign in (left sidebar) to log calls, doors, emails and meetings on this parcel. Your log is private to you (row-level security).</p>`;
    return;
  }
  let rows = [];
  try {
    const server = await api("/api/canvass", { fresh: true });
    rows = (server.canvass ?? []).filter((c) => c.bbl === bbl);
    const d = desk(); d.canvass = server.canvass ?? []; saveDesk(d); // cache
  } catch {
    rows = desk().canvass.filter((c) => c.bbl === bbl);
  }
  box.innerHTML = `
    <div style="display:grid;grid-template-columns:110px 1fr 140px auto;gap:7px;align-items:start">
      <select id="cv-type" class="field" style="padding:7px 9px;font-size:12px">${[["call", "Call"], ["door", "Door knock"], ["email", "Email"], ["meeting", "Meeting"], ["mailer", "Mailer"], ["other", "Other"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <input id="cv-note" class="field" placeholder="Note — what happened, who you spoke with…" style="font-size:12px" />
      <input id="cv-follow" type="date" class="field" style="font-size:12px" title="Follow-up date" />
      <button class="btn primary sm" id="cv-log" style="padding:8px 14px">Log</button>
    </div>
    <input id="cv-outcome" class="field" placeholder="Outcome (optional) — e.g. interested, callback, not selling" style="font-size:12px;margin-top:7px" />
    <div style="margin-top:10px;display:grid;gap:5px">
      ${rows.length ? rows.map((c) => `<div class="card" style="padding:8px 11px;display:flex;gap:8px;align-items:flex-start">
        <span class="badge" style="background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line)">${h(c.type)}</span>
        <div style="min-width:0;flex:1">${c.note ? `<p style="margin:0;font-size:12px">${h(c.note)}</p>` : ""}${c.outcome ? `<p class="note" style="margin:2px 0 0">Outcome: ${h(c.outcome)}</p>` : ""}<p class="note" style="margin:2px 0 0">${new Date(c.at).toLocaleString()}${c.follow ? ` · follow up ${c.follow}` : ""}</p></div>
      </div>`).join("") : `<p class="note">No touches logged yet on this parcel.</p>`}
    </div>`;
  el("#cv-log").addEventListener("click", async () => {
    const entry = { bbl, address: addr, type: el("#cv-type").value, note: el("#cv-note").value.trim(), outcome: el("#cv-outcome").value.trim(), follow: el("#cv-follow").value };
    try {
      await apiSend("/api/canvass", "POST", entry);
      const d2 = desk();
      d2.canvass.unshift({ ...entry, at: Date.now() });
      saveDesk(d2);
      renderCanvass(bbl, addr);
    } catch { toast("Could not save the touch — try again."); }
  });
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length / 2) | 0] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}
const stat = (v, l, n2, tone = "") => `<div class="stat ${tone}"><div class="v">${v}</div><div class="l">${h(l)}</div>${n2 ? `<div class="n">${h(n2)}</div>` : ""}</div>`;

function tableCard(headers, rows, empty) {
  return `<div class="table-wrap card"><table class="tbl">
    <thead><tr>${headers.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}" class="note">${h(empty)}</td></tr>`}</tbody></table></div>`;
}
