// Lot Detail flyout — the every-lot click panel: listing check, unused
// buildable + restrictions, ownership classification + portfolio, parcel and
// value facts, with a one-click path into the full dossier.
import { api } from "../api.js";
import { el, h, kvRow, spinner, icons } from "../ui.js";
import { num, usd } from "../lib/format.js";
import { airRights, classifyOwner, OWNER_KIND_LABELS, OWNER_KIND_NOTES, ownerUnavailable, LAND_USE_LABELS, boroughOfBbl } from "../lib/constants.js";

export async function renderLotDetail(container, p, { ownerCountInView = 0 } = {}) {
  const a = airRights(p);
  const kind = classifyOwner(p.owner);
  const hasOwner = !!p.owner && !ownerUnavailable(p.owner);
  const dossierHref = p.bbl ? `#/dossier?bbl=${p.bbl}&addr=${encodeURIComponent(p.address ?? "")}` : null;

  container.innerHTML = `
    <div style="padding:14px 16px">
      <h2 style="margin:0;font-size:15px;font-weight:750">${h(p.address ?? "Address not on record")}</h2>
      <p class="note" style="margin-top:3px">${p.bbl ? `BBL ${p.bbl}` : "—"}${p.zoning ? ` · ${h(p.zoning)}` : ""}${p.landUse && LAND_USE_LABELS[p.landUse] ? ` · ${h(LAND_USE_LABELS[p.landUse])}` : ""}</p>
      <div id="ld-listing" style="margin-top:8px"></div>
      ${dossierHref ? `
        <a class="btn ghost" style="width:100%;justify-content:center;margin-top:10px" href="${dossierHref}">Open the full live parcel workspace (permits / ownership / contacts) →</a>
        <p class="note" style="margin-top:5px">Adds to pipeline, watchlist, canvass log, lien check and investor matching.</p>` : ""}
      ${a.unusedBsf !== null && a.unusedBsf > 0 ? `
        <div class="callout blue" style="margin-top:10px">
          <p class="eyebrow" style="margin:0">Unused buildable</p>
          <p style="font-size:19px;font-weight:800;color:var(--accent-ink);margin:3px 0 2px" class="tabular">+${a.unusedBsf.toLocaleString()} bsf</p>
          <p class="note" style="margin:0">${a.maxFar} max FAR × ${num(p.lotArea)} sf lot − ${num(p.bldgArea)} sf built</p>
          ${a.encumbered.length
            ? `<div style="border-top:1px solid var(--accent-line);margin-top:8px;padding-top:7px">
                <p class="eyebrow dim" style="margin:0 0 4px">Restrictions on record</p>
                ${a.encumbered.map((e) => `<p style="margin:0;font-size:11.5px;font-weight:600">• ${h(e)}</p>`).join("")}
                <p class="note" style="margin:5px 0 0">Unused FAR here is not automatically transferable — these need clearing first.</p></div>`
            : `<p class="note" style="border-top:1px solid var(--accent-line);margin-top:8px;padding-top:7px">No landmark, historic-district, E-designation, split-zone or height restriction on record. Transfer still depends on a receiving lot and a zoning-lot merger.</p>`}
        </div>` : ""}
      ${a.unusedBsf === 0 ? `
        <div class="card" style="margin-top:10px;padding:10px 12px;background:var(--bg-sunken)">
          <p class="eyebrow dim" style="margin:0">${a.overbuilt ? "Overbuilt" : "Built out"}</p>
          <p style="margin:3px 0 0;font-size:12.5px;font-weight:600">${a.overbuilt ? `${p.builtFar} built FAR against ${a.maxFar} max — no air rights` : "No unused buildable at current zoning"}</p>
          ${a.overbuilt ? `<p class="note" style="margin:3px 0 0">Existing bulk exceeds what today's zoning allows.</p>` : ""}
        </div>` : ""}

      <div style="margin-top:12px"><span class="eyebrow dim">Ownership</span>
        ${kvRow("Owner of record", hasOwner ? h(p.owner) : "Not on record")}
        ${hasOwner ? kvRow("Owner type", h(OWNER_KIND_LABELS[kind] ?? "—")) : ""}
        ${p.mailAddress ? `<div class="callout blue" style="margin-top:7px;padding:8px 11px">
          <p class="eyebrow" style="margin:0;color:var(--accent-ink)">Absentee owner</p>
          <p style="margin:2px 0 0;font-size:11.5px;font-weight:600">Mails to ${h(p.mailAddress)}</p></div>` : ""}
        <div id="ld-portfolio"></div>
        ${hasOwner ? `<p class="note" style="margin-top:6px">${h(OWNER_KIND_NOTES[kind])}</p>` : ""}
      </div>

      <div style="margin-top:12px"><span class="eyebrow dim">Parcel</span>
        ${kvRow("Lot area", `${num(p.lotArea)} sf`)}${kvRow("Building area", `${num(p.bldgArea)} sf`)}
        ${kvRow("Floors", num(p.floors ?? p.numFloors))}${kvRow("Year built", p.yearBuilt ? String(p.yearBuilt) : "—")}
        ${kvRow("Building class", h(p.bldgClass ?? "—"))}
      </div>
      <div style="margin-top:12px"><span class="eyebrow dim">Units</span>
        ${kvRow("Total units", num(p.units ?? p.unitsTotal))}${kvRow("Residential units", num(p.unitsRes))}
      </div>
      <div style="margin-top:12px"><span class="eyebrow dim">Zoning & FAR</span>
        ${kvRow("Zoning district", h(p.zoning ?? "—"))}${kvRow("Built FAR", p.builtFar != null ? String(p.builtFar) : "—")}
        ${kvRow("Max residential FAR", p.maxResidFar != null ? String(p.maxResidFar) : "—")}
        ${kvRow("Max commercial FAR", p.maxCommFar != null ? String(p.maxCommFar) : "—")}
      </div>
      <div style="margin-top:12px"><span class="eyebrow dim">Assessment</span>
        ${kvRow("Assessed total", usd(p.assessedTotal))}
      </div>
      ${p.bbl ? `<div style="margin-top:12px" id="ld-hist"><span class="eyebrow dim">Asset history</span>
        <div style="margin-top:5px"><button class="btn sm ghost" id="ld-hist-btn">History →</button></div>
      </div>` : ""}
    </div>`;

  el("#ld-hist-btn", container)?.addEventListener("click", async () => {
    const hEl = el("#ld-hist", container);
    hEl.innerHTML = `<span class="eyebrow dim">Asset history</span><div style="padding:6px 0">${spinner("Pulling the recorded history…")}</div>`;
    try {
      const rec = await api(`/api/asset-history?bbl=${p.bbl}`);
      hEl.innerHTML = `<span class="eyebrow dim">Asset history</span>
        <div style="margin-top:5px;display:grid;gap:4px">
          ${(rec.sales ?? []).slice(0, 5).map((s) => `<div class="card" style="padding:7px 10px;font-size:11px;display:flex;justify-content:space-between;gap:8px"><span>${h(String(s.date).slice(0, 10))}</span><b>${s.amount > 0 ? usd(s.amount) : "—"}</b><span class="note" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(s.grantee)}</span></div>`).join("") || `<p class="note">No recorded deeds found for this lot.</p>`}
          <a class="btn sm" style="justify-content:center" href="#/dossier?bbl=${p.bbl}&addr=${encodeURIComponent(p.address ?? "")}">Open detail →</a>
        </div>`;
    } catch { hEl.innerHTML = `<span class="eyebrow dim">Asset history</span><div class="callout red" style="margin-top:5px">Could not load this asset's history.</div>`; }
  });

  // Listing check
  const listingEl = el("#ld-listing", container);
  if (p.address) {
    try {
      const lc = await api(`/api/listing-check?addr=${encodeURIComponent(p.address)}&boro=${encodeURIComponent(boroughOfBbl(p.bbl) ?? "")}`);
      if (lc.forSale) {
        listingEl.innerHTML = `<div class="callout red"><b style="color:var(--red)">🔴 LISTED FOR SALE</b>${(lc.hits ?? []).map((x) => `<a style="display:block;margin-top:4px;font-size:11.5px" href="${x.url}" target="_blank" rel="noopener">${h(x.source)}: ${h(x.title)}</a>`).join("")}</div>`;
      } else if (lc.configured === false) {
        listingEl.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:5px">${(lc.searches ?? []).slice(0, 5).map((s) => `<a class="chip" style="font-size:10.5px;padding:3px 9px" href="${s.url}" target="_blank" rel="noopener">${h(s.label)} ${icons.external}</a>`).join("")}</div>
        <p class="note" style="margin-top:4px">Listing check off — add the SERPER_API_KEY secret to enable.</p>`;
      } else {
        listingEl.innerHTML = `<p class="note">No active listing found on the major platforms.</p>`;
      }
    } catch { listingEl.innerHTML = ""; }
  }
  // Owner portfolio (citywide)
  const pf = el("#ld-portfolio", container);
  if (hasOwner) {
    pf.innerHTML = `<div style="padding:6px 0">${spinner("Checking this owner's portfolio…")}</div>`;
    try {
      const port = await api(`/api/owner-portfolio?owner=${encodeURIComponent(p.owner)}`);
      const inView = ownerCountInView;
      pf.innerHTML = (inView >= 2 || port.total >= 2)
        ? `<div class="callout blue" style="margin-top:7px;padding:9px 11px">
            <b style="font-size:11.5px;color:var(--accent-ink)">⚑ Owner has multiple properties</b>
            <p style="margin:3px 0 0;font-size:11.5px">${inView >= 2 ? `${inView} in this view — highlighted on the map. ` : ""}${port.total >= 1 ? `${port.total.toLocaleString()} citywide${port.units ? ` · ${port.units.toLocaleString()} units` : ""}.` : ""}</p>
            <p class="note" style="margin:4px 0 0">Citywide matches the owner name exactly, so spelling variants and single-purpose LLCs aren't counted — treat it as a floor. Full portfolio breakdown is in the dossier.</p>
          </div>`
        : "";
    } catch { pf.innerHTML = ""; }
  }
}
