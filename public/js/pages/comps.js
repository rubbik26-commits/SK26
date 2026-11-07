// Comps / Land Index — live benchmarks per strategy × borough plus the most
// recent qualifying comps ($/sf and zoning-adjusted $/bsf).
import { api } from "../api.js";
import { el, h, spinner } from "../ui.js";
import { num, usd, dateShort, exportCsv } from "../lib/format.js";

export async function mount(root) {
  root.innerHTML = `<div class="scroll" style="height:100%"><div style="max-width:1020px;margin:0 auto;padding:22px 18px 70px" id="cp">${spinner("Computing live comps from Rolling Sales…")}</div></div>`;
  let data;
  try { data = await api("/api/market-index"); }
  catch (e) { el("#cp").innerHTML = `<div class="callout red">Could not load live comps: ${h(e.message)}</div>`; return {}; }

  const strategies = [["multifamily", "Multifamily", "$/gross sf"], ["condo", "Condo", "$/gross sf"], ["office", "Office", "$/gross sf"], ["hotels", "Hotels", "$/gross sf"], ["development", "Development", "$/buildable sf"]];
  const markets = ["Manhattan", "Brooklyn", "Queens"];
  el("#cp").innerHTML = `
    <div class="eyebrow">Comps / Land Index</div>
    <h1 class="page-title">Live benchmarks from recorded citywide sales</h1>
    <p class="sub" style="max-width:760px">Computed from recorded sales over the last 12 months. Multifamily ($/gross sf) and development/land ($/land sf) are separated, with Manhattan, Brooklyn, and Queens shown independently. The comp table adds zoning-adjusted $/buildable sf for land sales. <span style="color:var(--accent-ink)">Updated ${new Date(data.fetchedAt).toLocaleString()}.</span></p>
    <div style="display:flex;justify-content:flex-end;margin:10px 0"><button class="btn sm" id="cp-export">Export comps CSV</button></div>
    ${strategies.map(([key, label, basis]) => `
      <div class="sect-head"><span class="t">${label}</span><span class="s">median ${basis} · trailing 12 months</span></div>
      <div class="statgrid">
        ${markets.map((m) => {
          const cell = data.index[key]?.[m];
          return `<div class="stat ${key === "development" ? "gold" : ""}">
            <div class="v">${cell?.medianPpsf != null ? "$" + num(cell.medianPpsf) : "—"}</div>
            <div class="l">${m}</div><div class="n">${cell?.count ?? 0} qualifying sales</div></div>`;
        }).join("")}
      </div>`).join("")}
    <div class="sect-head"><span class="t">Recent comps (live)</span><span class="s">${data.comps.length} most recent qualifying sales · $/bsf = zoning-adjusted $/buildable sf (land)</span></div>
    <div class="table-wrap card"><table class="tbl">
      <thead><tr><th>Address</th><th>Market</th><th>Submarket</th><th>Strategy</th><th>Type</th><th class="r">Units</th><th class="r">GSF</th><th class="r">Sale</th><th class="r">$/sf</th><th class="r">$/bsf</th><th>Date</th></tr></thead>
      <tbody>${data.comps.map((c) => `<tr>
        <td>${c.bbl ? `<a href="#/dossier?bbl=${c.bbl}&addr=${encodeURIComponent(c.address)}" title="Open this comp in the full Parcel Dossier">${h(c.address)} →</a>` : h(c.address)}</td>
        <td class="note">${h(c.market)}</td><td class="note">${h(c.submarket)}</td><td><b>${h(c.strategy)}</b></td>
        <td class="note" style="font-size:11px">${h(c.type)}</td><td class="r">${c.units ?? "—"}</td><td class="r">${c.gsf ? num(c.gsf) : "—"}</td>
        <td class="r">${usd(c.salePrice)}</td><td class="r" style="font-weight:700;color:${c.strategy === "Development" ? "var(--amber)" : "var(--accent-ink)"}">${usd(c.ppsf)}</td>
        <td class="r">${usd(c.ppbsf)}</td><td class="note">${dateShort(c.saleDate)}</td></tr>`).join("") || `<tr><td colspan="11" class="note" style="text-align:center;padding:16px">No qualifying recent sales returned.</td></tr>`}</tbody></table></div>`;
  el("#cp-export").addEventListener("click", () => exportCsv("nyc_recent_comps", [
    { header: "Address", value: (c) => c.address }, { header: "Market", value: (c) => c.market },
    { header: "Submarket", value: (c) => c.submarket }, { header: "Strategy", value: (c) => c.strategy },
    { header: "Type", value: (c) => c.type }, { header: "Units", value: (c) => c.units ?? "" },
    { header: "GSF", value: (c) => c.gsf ?? "" }, { header: "Sale price", value: (c) => c.salePrice },
    { header: "$/sf", value: (c) => c.ppsf ?? "" }, { header: "$/bsf", value: (c) => c.ppbsf ?? "" },
    { header: "Date", value: (c) => c.saleDate }
  ], data.comps));
  return {};
}
