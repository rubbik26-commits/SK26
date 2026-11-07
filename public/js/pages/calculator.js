// Deal Calculator — quick math with price + income; full underwriting with
// debt, exit, costs; development residual-land mode; plain-English parsing;
// parcel prefill; sensitivity grid; waterfall; and the branded document set
// (BOV book, Offering Memorandum, Deck).
import { api, desk, deskName } from "../api.js";
import { el, els, h, toast, sectionHead, openDocumentPreview, icons } from "../ui.js";
import { num, usd } from "../lib/format.js";
import { ASSET_CLASSES, underwrite, sensitivityGrid, waterfall, parsePlainEnglish, fUsd } from "../lib/underwrite.js";
import { generateDealDoc, parseCompLines, readFiguresFromText } from "../lib/deal-docs.js";

const FIELDS_INCOME = [
  { key: "askingPrice", label: "Asking price", pre: "$" }, { key: "buildingSf", label: "Building SF" },
  { key: "units", label: "Units / keys" }, { key: "grossIncome", label: "Gross income (annual)", pre: "$" },
  { key: "vacancyPct", label: "Vacancy", suf: "%" }, { key: "operatingExpenses", label: "Operating expenses (annual)", pre: "$" },
  { key: "noi", label: "NOI (from T12, optional)", pre: "$" }
];
const FIELDS_HOTEL = [{ key: "adr", label: "ADR", pre: "$" }, { key: "occupancyPct", label: "Occupancy", suf: "%" }];
const FIELDS_DEBT = [{ key: "ltvPct", label: "LTV", suf: "%" }, { key: "ratePct", label: "Rate", suf: "%" }, { key: "amortYears", label: "Amortization", suf: "yrs" }];
const FIELDS_EXIT = [{ key: "exitCapPct", label: "Exit cap", suf: "%" }, { key: "holdYears", label: "Hold", suf: "yrs" }, { key: "noiGrowthPct", label: "NOI growth / yr", suf: "%" }];
const FIELDS_COSTS = [{ key: "reservesPerUnit", label: "Reserves / unit (annual)", pre: "$" }, { key: "capexBudget", label: "Capex / reno budget", pre: "$" }, { key: "acqCostPct", label: "Acquisition costs", suf: "%" }, { key: "exitCostPct", label: "Exit / selling costs", suf: "%" }];
const FIELDS_DEV = [
  { key: "lotSf", label: "Lot SF" }, { key: "buildableSf", label: "Buildable SF" },
  { key: "hardCostPerSf", label: "Hard cost / SF", pre: "$" }, { key: "softCostPct", label: "Soft costs", suf: "%" },
  { key: "gdv", label: "Gross dev value (GDV)", pre: "$" }, { key: "targetProfitPct", label: "Target profit", suf: "%" },
  { key: "landPrice", label: "Land asking price", pre: "$" }, { key: "exitCapPct", label: "Exit cap (for yield-on-cost)", suf: "%" },
  { key: "grossIncome", label: "Stabilized gross income", pre: "$" }
];

const state = { assetClass: "multifamily", inputs: {}, io: false, address: "", bbl: null, compsText: "", priceNotes: "", bovPrice: "" };

export async function mount(root, { params }) {
  // URL prefill from any parcel handoff
  const map = [["calcPrice", "askingPrice"], ["calcSf", "buildingSf"], ["calcUnits", "units"], ["calcBuildable", "buildableSf"], ["calcLot", "lotSf"]];
  let prefilled = false;
  for (const [qk, ik] of map) if (params.get(qk)) { state.inputs[ik] = params.get(qk); prefilled = true; }
  if (params.get("calcAddr")) state.address = params.get("calcAddr");
  if (params.get("calcBbl")) state.bbl = params.get("calcBbl");
  if (params.get("calcClass")) state.assetClass = classFromBldg(params.get("calcClass"));

  root.innerHTML = `<div class="scroll" style="height:100%"><div style="max-width:1020px;margin:0 auto;padding:22px 18px 70px" id="cc"></div></div>`;
  render();
  if (prefilled) toast("Prefilled from the parcel — add price + income to underwrite.");
  if (state.bbl) pullParcel(state.bbl);
  return {};

  function set(key, value) { state.inputs[key] = value; renderResults(); }

  function render() {
    const dev = state.assetClass === "development";
    const fields = dev ? FIELDS_DEV : state.assetClass === "hotel" ? [...FIELDS_INCOME, ...FIELDS_HOTEL] : FIELDS_INCOME;
    el("#cc").innerHTML = `
      <div class="eyebrow">Deal Calculator</div>
      <h1 class="page-title">Underwrite it in seconds.</h1>
      <p class="sub">Quick math runs with just price + income. Add detail for institutional-grade accuracy.</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0">
        <select id="cc-class" class="field" style="width:auto;font-weight:650">${ASSET_CLASSES.map((c) => `<option value="${c.key}" ${state.assetClass === c.key ? "selected" : ""}>${c.label}</option>`).join("")}</select>
        <input id="cc-addr" class="field" placeholder="Property address (for the OM / BOV cover)" value="${h(state.address)}" style="flex:1;min-width:260px" />
        <button class="btn" id="cc-pull">Pull parcel</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <input id="cc-plain" class="field" placeholder='Say it in plain English — "value-add MF, asking 5m, 70 LTV, 6.5 rate, 5.5 exit, 5yr hold, NOI 280k"' style="flex:1" />
        <button class="btn ghost" id="cc-parse">Parse</button>
      </div>
      <p class="note" id="cc-msg" style="margin-bottom:10px"></p>
      <div style="display:grid;grid-template-columns:1fr 370px;gap:18px" class="cc-grid">
        <div style="display:grid;gap:16px">
          ${fieldGroup("Property & income", fields)}
          ${dev ? "" : `
            ${fieldGroup("Debt", FIELDS_DEBT, `<label style="display:flex;align-items:center;gap:7px;font-size:11.5px;margin-top:4px"><input type="checkbox" id="cc-io" ${state.io ? "checked" : ""} style="accent-color:var(--accent)" /> Interest-only</label>`)}
            ${fieldGroup("Exit & hold", FIELDS_EXIT)}
            ${fieldGroup("Costs & reserves", FIELDS_COSTS)}`}
          ${sectionHead("Comparables", "one per line, pipe-separated — short or full form both work")}
          <textarea id="cc-comps" class="field" rows="4" placeholder="830 Dean Street | Sold | 11/02/2025 | 9800000 | - | 31500 | 8200 | 1948 | Walk-Up | Multi | 100 | Investment | All Cash | 1187-22 | 6400000 | 2100000">${h(state.compsText)}</textarea>
          ${state.compsText.trim() ? "" : `<p class="note">No comps — the BOV will state that its sales-comparison approach could not be run.</p>`}
          <div style="display:grid;grid-template-columns:1fr 180px;gap:8px">
            <label class="lab">Price notes (value page)<input id="cc-notes" class="field" value="${h(state.priceNotes)}" placeholder="Reconciliation note…" /></label>
            <label class="lab">Stated BOV price<input id="cc-bov-price" class="field" type="number" value="${h(state.bovPrice)}" placeholder="14750000" /></label>
          </div>
          ${sectionHead("Offering documents", "— OM & Broker Opinion of Value from these numbers")}
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn primary" id="cc-bov">${icons.file} BOV book</button>
            <button class="btn" id="cc-om">${icons.file} Offering Memorandum</button>
            <button class="btn" id="cc-deck">Deck</button>
            <label class="btn ghost" style="cursor:pointer">Read figures from a document<input id="cc-doc" type="file" accept=".pdf,.txt,.csv,.tsv,.md,application/pdf,text/plain" style="display:none" /></label>
          </div>
          <p class="note">Branding (name, colors, logo, license) comes from <a href="#/desk">My Desk → Report branding</a>. Drop a T-12, rent roll or OM (PDF — scanned PDFs are OCR'd — or text/CSV) to prefill figures; you verify every value before it's applied.</p>
        </div>
        <div id="cc-results"></div>
      </div>
      <style>@media (max-width:900px){ .cc-grid{grid-template-columns:1fr !important} }</style>`;
    el("#cc-class").addEventListener("change", (e) => { state.assetClass = e.target.value; render(); });
    el("#cc-addr").addEventListener("change", (e) => { state.address = e.target.value; });
    el("#cc-pull").addEventListener("click", async () => {
      const q = state.address.trim();
      if (!q) return;
      try {
        const r = await api(`/api/address?q=${encodeURIComponent(q)}`);
        const hit = r.buildings?.[0];
        if (!hit) return toast("No parcel matched that address.");
        state.bbl = hit.bbl; state.address = hit.address;
        pullParcel(hit.bbl);
      } catch { toast("Lookup failed."); }
    });
    el("#cc-parse").addEventListener("click", doParse);
    el("#cc-plain").addEventListener("keydown", (e) => { if (e.key === "Enter") doParse(); });
    el("#cc-io")?.addEventListener("change", (e) => { state.io = e.target.checked; renderResults(); });
    els("[data-in]").forEach((inp) => inp.addEventListener("input", () => set(inp.dataset.in, inp.value)));
    el("#cc-comps").addEventListener("change", (e) => { state.compsText = e.target.value; });
    el("#cc-notes").addEventListener("change", (e) => { state.priceNotes = e.target.value; });
    el("#cc-bov-price").addEventListener("change", (e) => { state.bovPrice = e.target.value; });
    el("#cc-bov").addEventListener("click", () => generateDoc("bov"));
    el("#cc-om").addEventListener("click", () => generateDoc("om"));
    el("#cc-deck").addEventListener("click", () => generateDoc("deck"));
    el("#cc-doc").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const { extractDocText, EXTRACT_FIELD_LABELS } = await import("../lib/doc-extract.js");
        const { text, method } = await extractDocText(file, (s) => { el("#cc-msg").textContent = s; });
        const found = readFiguresFromText(text);
        const keys = Object.keys(found);
        if (!keys.length) { el("#cc-msg").textContent = "Couldn't read figures automatically — enter them manually."; return; }
        // User verification before extracted values are applied (item 27).
        const { openModal } = await import("../ui.js");
        const veil = openModal("Verify extracted figures", `
          <p style="font-size:12.5px;margin:0 0 10px">Read via ${method === "pdf-ocr" ? "OCR (scanned PDF)" : method === "pdf-text" ? "PDF text" : "plain text"} — confirm each figure before it's applied. Edit anything that's wrong.</p>
          <div style="display:grid;gap:8px">${keys.map((k) => `
            <label class="lab" style="display:flex;align-items:center;gap:9px">
              <input type="checkbox" data-x-use="${k}" checked style="accent-color:var(--accent)" />
              <span style="flex:1">${EXTRACT_FIELD_LABELS[k] ?? k}</span>
              <input class="field" data-x-val="${k}" value="${String(found[k])}" style="width:150px;text-align:right" />
            </label>`).join("")}</div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
            <button class="btn" data-x-cancel>Cancel</button>
            <button class="btn primary" data-x-apply>Apply to the underwriting</button>
          </div>`);
        veil.querySelector("[data-x-cancel]").addEventListener("click", () => { veil.remove(); el("#cc-msg").textContent = "Nothing applied."; });
        veil.querySelector("[data-x-apply]").addEventListener("click", () => {
          const applied = [];
          for (const k of keys) {
            if (!veil.querySelector(`[data-x-use="${k}"]`).checked) continue;
            state.inputs[k] = veil.querySelector(`[data-x-val="${k}"]`).value.trim();
            applied.push(k);
          }
          veil.remove();
          render();
          el("#cc-msg").textContent = applied.length ? `Applied ${applied.join(", ")} — verified by you.` : "Nothing applied.";
        });
      } catch (err) { el("#cc-msg").textContent = `Document read failed — ${err?.message ?? "enter figures manually"}.`; }
    });
    renderResults();
  }

  function fieldGroup(title, fields, extra = "") {
    return `<div class="card card-pad">
      <p class="eyebrow dim" style="margin:0 0 9px">${h(title)}</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
        ${fields.map((f) => `<label class="lab">${h(f.label)}
          <div style="position:relative">${f.pre ? `<span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--ink-faint)">$</span>` : ""}
          <input class="field" data-in="${f.key}" inputmode="decimal" value="${h(state.inputs[f.key] ?? "")}" style="${f.pre ? "padding-left:20px" : ""}" />
          ${f.suf ? `<span style="position:absolute;right:9px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--ink-faint)">${f.suf}</span>` : ""}</div></label>`).join("")}
      </div>${extra}</div>`;
  }

  function doParse() {
    const text = el("#cc-plain").value.trim();
    if (!text) return;
    const { inputs, assetClass } = parsePlainEnglish(text);
    if (assetClass) state.assetClass = assetClass;
    const keys = Object.keys(inputs);
    if (!keys.length) { el("#cc-msg").textContent = `Couldn't parse that — try e.g. "asking 5m, 70 LTV, 6.5 rate, 5.5 exit, 5yr hold".`; return; }
    for (const k of keys) state.inputs[k] = String(inputs[k]);
    el("#cc-msg").textContent = `Parsed: ${keys.join(", ")}. Adjust anything below.`;
    render();
  }

  async function pullParcel(bbl) {
    try {
      const rec = await api(`/api/asset-history?bbl=${bbl}`);
      const p = rec.pluto ?? {};
      if (!state.inputs.buildingSf && p.bldgArea) state.inputs.buildingSf = String(p.bldgArea);
      if (!state.inputs.units && (p.unitsRes || p.unitsTotal)) state.inputs.units = String(p.unitsRes || p.unitsTotal);
      if (!state.inputs.lotSf && p.lotArea) state.inputs.lotSf = String(p.lotArea);
      if (p.bldgClass) state.assetClass = classFromBldg(p.bldgClass);
      state.parcel = rec;
      const comps = (rec.comps ?? []).map((c) => {
        const sfEst = c.price && c.ppsf ? Math.round(c.price / c.ppsf) : "";
        return [c.address, "Sold", c.date || "-", c.price || "-", "", sfEst].join(" | ");
      });
      if (comps.length && !state.compsText) {
        state.compsText = comps.join("\n");
        el("#cc-msg").textContent = `Pulled ${comps.length} comparable sale${comps.length === 1 ? "" : "s"} from the last 24 months (same ZIP + building class).`;
      }
      render();
    } catch { /* curated demo bbl — fine */ }
  }

  function inputsObj() {
    const out = { assetClass: state.assetClass, interestOnly: state.io };
    for (const k of Object.keys(state.inputs)) out[k] = state.inputs[k];
    return out;
  }

  function renderResults() {
    const inputs = inputsObj();
    const uw = underwrite(inputs);
    const grid = sensitivityGrid(inputs);
    const wf = waterfall(uw.equity, uw.cashflows);
    const flag = (f) => f === "good" ? "var(--green)" : f === "watch" ? "var(--amber)" : f === "bad" ? "var(--red)" : "var(--ink)";
    el("#cc-results").innerHTML = `
      <div class="card card-pad" style="position:sticky;top:10px">
        <p class="eyebrow dim" style="margin:0 0 6px">Underwriting</p>
        <div class="callout blue" style="font-size:12px;margin-bottom:9px">${h(uw.summary)}</div>
        <div style="display:grid;gap:2px">
          ${uw.metrics.map((m) => `<div class="kv"><span class="k">${h(m.label)}${m.note ? `<span class="note" style="display:block">${h(m.note)}</span>` : ""}</span><span class="v tabular" style="color:${flag(m.flag)}">${h(m.value)}</span></div>`).join("") || `<p class="note">Enter numbers on the left — metrics appear as soon as they can be computed.</p>`}
        </div>
        ${uw.gaps.length ? `<p class="eyebrow dim" style="margin:12px 0 4px">To tighten it, add</p><ul style="margin:0;padding-left:15px;display:grid;gap:2px">${uw.gaps.map((g) => `<li class="note">${h(g)}</li>`).join("")}</ul>` : ""}
        ${grid ? `<p class="eyebrow dim" style="margin:13px 0 5px">IRR sensitivity</p>
          <div class="table-wrap"><table class="tbl" style="font-size:11px">
            <thead><tr><th>NOI growth ↓ / Exit cap →</th>${grid.exitCaps.map((c) => `<th class="r">${c}%</th>`).join("")}</tr></thead>
            <tbody>${grid.growths.map((g, gi) => `<tr><td><b>${g}%</b></td>${grid.grid[gi].map((v) => `<td class="r" style="color:${v == null ? "var(--ink-faint)" : v >= 15 ? "var(--green)" : v >= 10 ? "var(--amber)" : "var(--red)"}">${v == null ? "—" : v.toFixed(1) + "%"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : ""}
        ${wf ? `<p class="eyebrow dim" style="margin:13px 0 5px">Equity waterfall <span style="font-weight:400;text-transform:none;letter-spacing:0">— 8% pref · 20% promote</span></p>
          <div class="kv"><span class="k">Total profit</span><span class="v tabular">$${num(wf.profit)}</span></div>
          <div class="kv"><span class="k">LP take · ${wf.lpMultiple}×</span><span class="v tabular">$${num(wf.lp)}</span></div>
          <div class="kv"><span class="k">GP promote</span><span class="v tabular">$${num(wf.gp)}</span></div>
          <p class="note" style="margin-top:5px">Two-tier: return of capital + compounded 8% pref to LP, then 80/20 split above pref.</p>` : ""}
      </div>`;
  }

  async function generateDoc(type) {
    if (!state.address.trim()) { toast("Add a property address — it goes on the cover of the document."); return; }
    const inputs = inputsObj();
    const uw = underwrite(inputs);
    const p = state.parcel?.pluto ?? {};
    const numIn = (k) => { const v = parseFloat(String(state.inputs[k] ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(v) ? v : null; };
    const price = numIn("askingPrice");
    const units = p.unitsRes || p.unitsTotal || numIn("units");
    const bbl = state.bbl ?? state.parcel?.bbl ?? null;

    // Market context (transit + demographics) rides along when a parcel is set.
    let market = {};
    if (bbl) {
      const [transit, demo2] = await Promise.all([
        api(`/api/transit?bbl=${bbl}`).catch(() => null),
        p.zip ? api(`/api/demographics?zips=${p.zip}`).catch(() => null) : Promise.resolve(null)
      ]);
      market = { stations: transit?.stations ?? [], demographics: demo2 ?? null };
    }

    const d = desk();
    const brand = { ...(d.brand ?? {}), display_name: d.brand?.display_name || deskName() || "" };
    const deal = {
      name: state.address.trim(),
      asset_type: state.assetClass,
      property: {
        address: state.address.trim(), bbl,
        neighborhood: p.neighborhood ?? null, zoning: p.zoning ?? null, year_built: p.yearBuilt ?? null,
        units: units ?? null, sf: p.bldgArea ?? numIn("buildingSf"), lot_sf: p.lotArea ?? numIn("lotSf"),
        far_used: p.builtFar ?? null, far_max: p.maxFar ?? null,
        lat: p.lat ?? null, lng: p.lng ?? null
      },
      financials: {
        gross_income: numIn("grossIncome"),
        vacancy_pct: numIn("vacancyPct") != null ? numIn("vacancyPct") / 100 : 0,
        opex: numIn("operatingExpenses")
      },
      underwriting: {
        asking_price: price,
        market_cap_rate: numIn("exitCapPct") != null ? numIn("exitCapPct") / 100 : null,
        loan: {
          amount: price && numIn("ltvPct") != null ? Math.round(price * (numIn("ltvPct") / 100)) : null,
          rate: numIn("ratePct") != null ? numIn("ratePct") / 100 : null,
          amort_years: numIn("amortYears")
        },
        hold_years: numIn("holdYears"),
        exit_cap: numIn("exitCapPct") != null ? numIn("exitCapPct") / 100 : null,
        noi_growth_pct: numIn("noiGrowthPct") != null ? numIn("noiGrowthPct") / 100 : 0,
        exit_cost_pct: numIn("exitCostPct") != null ? numIn("exitCostPct") / 100 : 0
      },
      ownership: p.owner ? { current_owner: p.owner, last_sale_price: state.parcel?.metrics?.lastSalePrice ?? null, last_sale_date: state.parcel?.metrics?.lastSaleDate ?? null } : {},
      market,
      comps: parseCompLines(state.compsText, units ?? null),
      copy: { price_notes: state.priceNotes.trim() || undefined, bov_price: parseFloat(state.bovPrice.replace(/[^0-9.]/g, "")) || undefined },
      brand
    };
    // A T-12 NOI beats the derived one when the operating lines are absent.
    if (deal.financials.gross_income == null && uw.noi != null) {
      deal.financials.gross_income = uw.noi;
      deal.financials.opex = 0;
      deal.financials.vacancy_pct = 0;
    }
    try {
      const html = generateDealDoc(deal, type);
      openDocumentPreview(type === "bov" ? "Broker Opinion of Value" : type === "om" ? "Offering Memorandum" : "Deck", html);
    } catch (err) {
      toast(`Document failed to build: ${err?.message || err}`);
    }
  }
}
function classFromBldg(cls) {
  const c = (cls || "").slice(0, 1).toUpperCase();
  return c === "O" ? "office" : ["R", "S", "C", "D"].includes(c) ? "multifamily" : ["K", "L", "M"].includes(c) ? "retail" : ["E", "F"].includes(c) ? "industrial" : c === "H" ? "hotel" : c === "V" ? "development" : "multifamily";
}
