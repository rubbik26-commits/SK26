// Deal Radar — off-market origination: propensity-ranked lots per area with
// the model backtest, expandable why-it-scores rows, owner rollup, and export.
import { api } from "../api.js";
import { el, els, h, statCard, spinner, toast, icons } from "../ui.js";
import { num, usd, fixed, exportCsv } from "../lib/format.js";
import { resolveAreaToZips, LAND_USE_LABELS } from "../lib/constants.js";
import { propensityFor } from "../lib/intel.js";
import { matchInvestors } from "../lib/investor-match.js";

const state = { q: "", committed: "", minProp: 25, boro: "" };
let TERRS = null;

export async function mount(root) {
  TERRS ??= await api("/api/territories");
  root.innerHTML = `<div class="scroll" style="height:100%"><div style="max-width:1000px;margin:0 auto;padding:22px 18px 70px" id="rd"></div></div>`;
  render();

  function resolveZips(q) {
    const a = resolveAreaToZips(q);
    if (a.zips.length) return a;
    const t = TERRS.find((x) => x.label.toLowerCase() === q.toLowerCase() || x.keywords?.some((k) => k === q.toLowerCase() || k.includes(q.toLowerCase()) || q.toLowerCase().includes(k)));
    return t ? { zips: t.zips, label: t.label } : { zips: [], label: q };
  }

  function render() {
    el("#rd").innerHTML = `
      <div class="eyebrow">${icons.radar} Off-market origination · Beta</div>
      <h1 class="page-title">Deal Radar — your best off-market targets.</h1>
      <p class="sub" style="max-width:720px">Pick an area. Every lot is ranked by a modeled <b>opportunity & seller-approachability</b> score from free public-record signals (under-built envelope, land-heavy value, aging stock, individual ownership), with the owner-portfolio rollup and a one-click path to each owner's full dossier. The backtest below shows, per submarket, how the ranking lines up with lots that actually sold.</p>
      <div style="display:flex;gap:8px;margin:14px 0 8px">
        <input id="rd-q" class="field" placeholder="Neighborhood or ZIP(s) — e.g. Bed-Stuy, 11216, or Brooklyn" value="${h(state.q)}" style="flex:1" />
        <button class="btn primary" id="rd-go">Scan area</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
        ${["Manhattan", "Brooklyn", "Queens"].map((b) => `<button class="chip ${state.boro === b ? "on" : ""}" data-boro="${b}">${b}</button>`).join("")}
      </div>
      ${state.boro ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px">
        ${TERRS.filter((t) => t.borough === state.boro).sort((a, b) => a.label.localeCompare(b.label)).map((t) => `<button class="chip ${state.committed === t.label ? "on" : ""}" data-hood="${h(t.label)}" style="font-size:10.5px;padding:3px 10px">${h(t.label)}</button>`).join("")}
      </div>` : `<p class="note" style="margin-bottom:12px">Pick a borough to see its neighborhoods — or type any neighborhood/ZIP above.</p>`}
      <div id="rd-results">${state.committed ? "" : `<div class="card" style="border-style:dashed;padding:36px;text-align:center"><p class="sub">Enter a neighborhood or ZIP to scan for the highest-opportunity off-market targets.</p></div>`}</div>`;
    const go = () => { state.q = el("#rd-q").value.trim(); state.committed = state.q; render(); if (state.committed) scan(); };
    el("#rd-go").addEventListener("click", go);
    el("#rd-q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    els("[data-boro]").forEach((b) => b.addEventListener("click", () => { state.boro = state.boro === b.dataset.boro ? "" : b.dataset.boro; render(); }));
    els("[data-hood]").forEach((b) => b.addEventListener("click", () => { state.q = b.dataset.hood; state.committed = b.dataset.hood; render(); scan(); }));
    if (state.committed) scan();
  }

  async function scan() {
    const out = el("#rd-results");
    const info = resolveZips(state.committed);
    if (!info.zips.length) { out.innerHTML = `<div class="callout red">Couldn't scan this area. Try a neighborhood name or 5-digit ZIP(s).</div>`; return; }
    out.innerHTML = `<div style="padding:16px 0">${spinner(`Scanning ${info.label || state.committed} for seller signals…`)}</div>`;
    let data, val, investorPool;
    try {
      [data, val, investorPool] = await Promise.all([
        api(`/api/area-buildings?zips=${info.zips.join(",")}&sort=propensity&pageSize=200`),
        api(`/api/propensity-validation?zips=${info.zips.join(",")}`).catch(() => null),
        // Owner-only (audit item 28): 401/403 leaves the pool null and the
        // owner-only note renders instead of investor fits.
        api("/api/investors", { fresh: true }).then((r) => r.investors ?? []).catch(() => null)
      ]);
    } catch { out.innerHTML = `<div class="callout red">Couldn't scan this area.</div>`; return; }
    const boroughGuess = info.label?.match(/Manhattan|Brooklyn|Queens|Bronx|Staten Island/)?.[0] ?? null;
    function investorFitHtml(b) {
      if (!investorPool?.length) return "";
      const m = matchInvestors(investorPool, {
        borough: b.borough ?? boroughGuess, bldgClass: b.bldgClass,
        price: b.assessTotal ?? null, units: b.unitsRes ?? null
      }).filter((x) => x.fit || x.score >= 0.6);
      if (!m.length) return "";
      return `<p class="eyebrow dim" style="margin:0 0 4px">Fits your buyers</p>
        <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px">${m.slice(0, 5).map((x) => `
          <span class="badge" style="background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line)" title="${h(x.reasons.join(", "))}">${h(x.investor.name || x.investor.firm || "—")} ${x.fit ? "✓" : `${Math.round(x.score * 100)}%`}</span>`).join("")}
          <a class="chip" style="font-size:10.5px;padding:3px 9px" href="#/investors">Manage your pool →</a></div>`;
    }
    const all = data.buildings;
    const hits = all.filter((b) => (b.propensity ?? 0) >= state.minProp);
    const owners = new Map();
    for (const b of all) {
      const key = (b.owner || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!key || /^(NYC|CITYOF)/.test(key)) continue;
      const cur = owners.get(key) ?? { name: b.owner, rows: [] };
      cur.rows.push(b); owners.set(key, cur);
    }
    const rollup = [...owners.values()].filter((o) => o.rows.length >= 2)
      .map((o) => ({ name: o.name, count: o.rows.length, units: o.rows.reduce((n, r) => n + (r.unitsRes ?? 0), 0), avgProp: Math.round(o.rows.reduce((n, r) => n + (r.propensity ?? 0), 0) / o.rows.length), topBbl: o.rows[0].bbl }))
      .sort((a, b) => b.count - a.count || b.avgProp - a.avgProp).slice(0, 12);
    const chipCls = (p2) => p2 >= 55 ? "background:var(--red);color:#fff" : p2 >= 35 ? "background:var(--amber);color:#fff" : "background:#9a7400;color:#fff";

    out.innerHTML = `
      <div class="statgrid" style="margin-bottom:14px">
        ${statCard({ value: num(all.length), label: "Lots scanned", note: info.label || state.committed })}
        ${statCard({ value: String(hits.length), label: "High-propensity", note: `score ≥ ${state.minProp}`, tone: "gold" })}
        ${statCard({ value: String(rollup.length), label: "Multi-lot owners", note: "portfolio targets" })}
        ${statCard({ value: String(all[0]?.propensity ?? "—"), label: "Top score", note: "in this page" })}
      </div>
      ${val && val.lift != null ? (val.provenance === "live"
        ? `<div class="callout ${val.lift >= 1.15 ? "green" : val.lift >= 0.9 ? "blue" : "amber"}" style="margin-bottom:12px;font-size:11.5px">
          <b>Model validation (backtest — recorded transactions):</b> ${num(val.sample)} live lots scored; of the <b>${num(val.sold)}</b> that <b>actually sold</b> here in the last 12 months (recorded arm's-length sales), the top propensity band sold at <b>${val.topBandRatePct}%</b> vs a <b>${val.baseRatePct}%</b> base rate — a <b>${val.lift}× lift</b>.
          ${val.lift >= 1.15 ? "The top band over-indexes on real recorded sellers — the ranking is doing real work, not just expert-set weights." : val.lift >= 0.9 ? "Signals track the base rate in this submarket — lean on the relative ranking (top of the list) more than the absolute band here." : "Recent sellers under-indexed on the signals here — treat this area's ranking with extra caution and weight relationships/timing."}</div>`
        : `<div class="callout amber" style="margin-bottom:12px;font-size:11.5px">
          <b>Simulation / demo validation:</b> this backtest ran on the modeled demo universe, not recorded transactions — a <b>${val.lift}× lift</b> in simulation. It demonstrates the workflow, not real-world performance.</div>`) : ""}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px">
        <label class="note" style="display:flex;align-items:center;gap:9px">Min propensity
          <input id="rd-min" type="range" min="0" max="60" step="1" value="${state.minProp}" style="width:160px" />
          <b class="tabular" id="rd-min-val">${state.minProp}</b></label>
        <button class="btn sm" id="rd-export">Export call list</button>
      </div>
      <div class="table-wrap card" style="margin-bottom:16px"><table class="tbl">
        <thead><tr><th>Score</th><th>Address</th><th>Owner of record</th><th>Why now</th><th></th></tr></thead>
        <tbody id="rd-rows"></tbody></table></div>
      ${rollup.length ? `
        <div class="sect-head"><span class="t">Owner-portfolio rollup — who holds the most here</span></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:8px">
          ${rollup.map((o) => `<a class="card" style="padding:11px 13px;display:block" href="#/dossier?bbl=${o.topBbl}">
            <div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h(o.name)}</b><span class="badge" style="background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line)">${o.count} lots</span></div>
            <p class="note" style="margin:4px 0 0">${num(o.units)} resi units · avg propensity ${o.avgProp}</p></a>`).join("")}
        </div>
        <p class="note" style="margin-top:6px">Owners holding multiple lots in this farm — portfolio-level outreach targets. Grouped by owner-of-record name (a lightweight ownership graph; full LLC-to-principal resolution is a later phase).</p>` : ""}
      ${investorPool == null ? `<p class="note" style="margin-top:10px">Investor buy-box matching is owner-only. Activate owner mode to see which of your investors fits each lead.</p>` : ""}
      <p class="note" style="margin-top:12px">Beta — seller-propensity is a modeled signal from public records: it ranks where to spend outreach time, not a prediction of price or a guarantee. Open any lead's dossier for owner contacts and the full distress / debt-maturity read. Showing the top page of lots for the area.</p>`;

    function renderRows() {
      const rows = all.filter((b) => (b.propensity ?? 0) >= state.minProp).slice(0, 60);
      el("#rd-rows").innerHTML = rows.length ? rows.map((b) => `
        <tr data-row="${b.bbl}" style="cursor:pointer">
          <td><span class="badge tabular" style="${chipCls(b.propensity ?? 0)};border-color:transparent;min-width:30px;justify-content:center">${b.propensity}</span></td>
          <td><b>${h(b.address)}</b></td><td style="font-size:11.5px">${h(b.owner || "—")}</td>
          <td class="note" style="max-width:260px">${h(b.propensityWhy || "—")}</td>
          <td class="r"><span style="color:var(--ink-faint)">▾</span></td>
        </tr>
        <tr data-detail="${b.bbl}" style="display:none"><td colspan="5" style="background:var(--bg-sunken)">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:2px 18px;font-size:11px;margin-bottom:9px">
            ${[["Type", LAND_USE_LABELS[b.landUse] ?? "—"], ["Class", b.bldgClass || "—"], ["Resi units", b.unitsRes ?? "—"], ["Year built", b.yearBuilt || "—"], ["Lot", `${num(b.lotArea)} sf`], ["Building", `${num(b.bldgArea)} sf`], ["FAR", `${fixed(b.builtFar)} / ${fixed(b.maxFar)}`], ["Unused FAR", b.unusedFarSf ? `${num(b.unusedFarSf)} sf` : "—"], ["Assessed", usd(b.assessTotal)], ["Zoning", b.zoning || "—"]]
              .map(([k, v]) => `<span style="display:flex;justify-content:space-between;border-bottom:1px solid var(--line-soft);padding:2px 0"><span style="color:var(--ink-faint)">${k}</span><b>${h(String(v))}</b></span>`).join("")}
          </div>
          <p class="eyebrow dim" style="margin:0 0 4px">Why it scores ${b.propensity}</p>
          <ul style="margin:0 0 9px;padding-left:16px;display:grid;gap:3px">${propensityFor(b).reasons.map((r) => `<li style="font-size:11.5px">${h(r)}</li>`).join("") || `<li class="note">No strong seller signals on the public record for this lot.</li>`}</ul>
          ${investorFitHtml(b)}
          <a class="btn primary sm" href="#/dossier?bbl=${b.bbl}&addr=${encodeURIComponent(b.address || "")}">Open full Dossier ${icons.external}</a>
        </td></tr>`).join("")
        : `<tr><td colspan="5" class="note" style="text-align:center;padding:18px">No lots at or above propensity ${state.minProp} in this area. Lower the threshold or pick a denser farm.</td></tr>`;
      els("[data-row]").forEach((r) => r.addEventListener("click", () => {
        const d = el(`[data-detail="${r.dataset.row}"]`);
        d.style.display = d.style.display === "none" ? "" : "none";
      }));
    }
    renderRows();
    el("#rd-min").addEventListener("input", (e) => { state.minProp = +e.target.value; el("#rd-min-val").textContent = state.minProp; renderRows(); });
    el("#rd-export").addEventListener("click", () => {
      const rows = all.filter((b) => (b.propensity ?? 0) >= state.minProp);
      if (!rows.length) return toast("Nothing above the threshold.");
      exportCsv(`deal_radar_${(info.label || state.committed).replace(/[^a-z0-9]+/gi, "_")}`, [
        { header: "Propensity", value: (b) => b.propensity }, { header: "Address", value: (b) => b.address },
        { header: "BBL", value: (b) => b.bbl }, { header: "Owner", value: (b) => b.owner },
        { header: "Why now", value: (b) => b.propensityWhy }, { header: "Units", value: (b) => b.unitsRes },
        { header: "Unused FAR sf", value: (b) => b.unusedFarSf }, { header: "Assessed", value: (b) => b.assessTotal }
      ], rows);
    });
  }
  return {};
}
