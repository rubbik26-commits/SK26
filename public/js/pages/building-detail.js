// Building Detail drawer (buildings mode): justification, contacts finder,
// full parcel facts, live records drill-down with exports, official links.
import { api } from "../api.js";
import { el, els, h, scorePill, kvRow, spinner, pillBadge, icons } from "../ui.js";
import { num, usd, fixed, exportCsv, BUILDING_EXPORT_COLUMNS } from "../lib/format.js";
import { LAND_USE_LABELS, govLinks } from "../lib/constants.js";
import { buildingJustification } from "../lib/intel.js";

export async function renderBuildingDetail(container, b) {
  const j = buildingJustification(b);
  const links = govLinks(b.bbl, b.block, b.lot);
  container.innerHTML = `
    <div style="padding:15px 16px;border-bottom:1px solid var(--line)">
      <div style="display:flex;gap:11px">${scorePill(b.score, 44)}
        <div style="min-width:0;flex:1">
          <h2 style="margin:0;font-size:15px;font-weight:750;line-height:1.2">${h(b.address)}</h2>
          <p class="note" style="margin-top:2px"><span class="mono">BBL ${b.bbl}</span> · ZIP ${h(b.zip ?? "—")}</p>
        </div></div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:9px">
        ${pillBadge(`Dev score ${b.score}/100`)}
        ${b.propensity != null && b.propensity >= 18 ? `<span class="badge" style="background:${b.propensity >= 55 ? "var(--red-soft)" : "var(--amber-soft)"};color:${b.propensity >= 55 ? "var(--red)" : "var(--amber)"};border-color:currentColor" title="${h(b.propensityWhy || "")}">⚡ Sell-propensity ${b.propensity}</span>` : ""}
        <span class="badge" style="background:var(--bg-sunken);color:var(--ink-soft);border-color:var(--line)">${h(LAND_USE_LABELS[b.landUse] ?? b.landUse ?? "—")}</span>
        <span class="badge" style="background:var(--bg-sunken);color:var(--ink-soft);border-color:var(--line)">Class ${h(b.bldgClass ?? "—")}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:11px">
        <a class="btn primary" style="justify-content:center" title="Load this parcel into the full Parcel Dossier tab — imagery, full sales/owner history, financing, permits, contacts & report" href="#/dossier?bbl=${b.bbl}&addr=${encodeURIComponent(b.address)}&zip=${encodeURIComponent(b.zip ?? "")}">${icons.file} Full Dossier →</a>
        <button class="btn" style="justify-content:center" id="bd-export">Export this building</button>
      </div>
    </div>
    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px"><span class="eyebrow dim">Investment Justification</span>${pillBadge(j.tier)}</div>
      <div class="callout blue"><p style="margin:0;font-weight:550;font-size:12px">${h(j.thesis)}</p></div>
      <ul style="margin:8px 0 0;padding-left:16px;display:grid;gap:4px">${j.drivers.map((d) => `<li style="font-size:11.5px;line-height:1.5">${h(d)}</li>`).join("")}</ul>
      <p class="note" style="font-style:italic;margin-top:7px">${h(j.caveat)}</p>
    </section>
    <section style="padding:13px 16px;border-bottom:1px solid var(--line)" id="bd-contacts">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="eyebrow dim">Live contacts (free public records)</span>
        <button class="btn sm ghost" id="bd-find">Find contacts</button>
      </div>
      <p class="note" style="margin-top:6px">Pulls contractor/permittee names + phones from permit records, the owner LLC's registered mailing address from state business filings, and recorded ownership party addresses — all free public records.</p>
    </section>
    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Development & Zoning</span>
      <div style="margin-top:5px">
        ${kvRow("Built FAR", fixed(b.builtFar), true)}
        ${kvRow("Max FAR (resi/comm/fac)", `${fixed(b.residFar)} / ${fixed(b.commFar)} / ${fixed(b.facilFar)}`, true)}
        ${kvRow("Unused buildable", b.unusedFarSf ? `${num(b.unusedFarSf)} sf` : "—", true)}
        ${kvRow("Zoning", h(b.zoning ?? "—"))}${kvRow("Overlay", h(b.overlay || "—"))}${kvRow("Special district", h(b.specialDistrict || "—"))}
      </div>
    </section>
    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Lot & Building</span>
      <div style="margin-top:5px">
        ${kvRow("Borough / Block / Lot", `${h(b.borough)} / ${b.block} / ${b.lot}`, true)}
        ${kvRow("Lot area", `${num(b.lotArea)} sf`, true)}${kvRow("Building area", `${num(b.bldgArea)} sf`, true)}
        ${kvRow("Residential area", `${num(b.resArea)} sf`, true)}${kvRow("Commercial area", `${num(b.comArea)} sf`, true)}
        ${kvRow("Floors", num(b.numFloors), true)}${kvRow("Resi units / total", `${num(b.unitsRes)} / ${num(b.unitsTotal)}`, true)}
        ${kvRow("Year built / altered", `${b.yearBuilt || "—"} / ${b.yearAltered || "—"}`, true)}
        ${kvRow("Lot frontage × depth", `${num(b.lotFront)} × ${num(b.lotDepth)} ft`, true)}
      </div>
    </section>
    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Assessment & Ownership</span>
      <div style="margin-top:5px">
        ${kvRow("Assessed land", usd(b.assessLand), true)}${kvRow("Assessed total", usd(b.assessTotal), true)}
        ${kvRow("Owner (record)", h(b.owner ?? "—"))}
      </div>
    </section>
    <section style="padding:13px 16px;border-bottom:1px solid var(--line)" id="bd-live">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="eyebrow dim">Live Records — Drill Down</span>
        <button class="btn sm ghost" id="bd-pull" title="Re-pull live evidence for the selected parcel">${icons.refresh} Pull records</button>
      </div>
      <p class="note" style="margin-top:6px">Sales · permits · recent filings · recorded debt · ZAP — each section exports to CSV.</p>
    </section>
    <section style="padding:13px 16px">
      <span class="eyebrow dim">Open Official Records</span>
      <div style="display:grid;gap:6px;margin-top:7px">
        ${[["NYC Property Information Portal (lot)", links.propPortal], ["Recorded document search (BBL)", links.acris], ["Buildings property profile (permits/violations)", links.bisweb], ["Zoning map — zoning, overlays & flood (this lot)", links.zola]]
          .map(([l, u]) => `<a class="card" style="padding:9px 11px;display:flex;justify-content:space-between;font-size:11.5px;font-weight:650" href="${u}" target="_blank" rel="noopener">${h(l)} ${icons.external}</a>`).join("")}
      </div>
    </section>`;

  el("#bd-export", container).addEventListener("click", () => exportCsv(`building_${b.bbl}`, BUILDING_EXPORT_COLUMNS, [b]));
  el("#bd-find", container).addEventListener("click", () => loadContacts(container, b));
  el("#bd-pull", container).addEventListener("click", () => loadLive(container, b));
}

async function loadContacts(container, b) {
  const target = el("#bd-contacts", container);
  target.innerHTML = `<span class="eyebrow dim">Live contacts (free public records)</span><div style="padding:8px 0">${spinner("Looking up the state registration…")}</div>`;
  try {
    const c = await api(`/api/contacts?bbl=${b.bbl}&borough=${b.borough}&block=${b.block}&lot=${b.lot}`);
    target.innerHTML = `<span class="eyebrow dim">Live contacts (free public records)</span>
      <div style="margin-top:7px;display:grid;gap:8px">
        ${b.mailAddress ? `<div><b style="font-size:11px">Owner mailing address</b>
          <div class="card" style="padding:7px 10px;font-size:11px;margin-top:4px"><b>${h(b.owner ?? "—")}</b><div class="note">${h(b.mailAddress)}</div></div></div>` : ""}
        <div><b style="font-size:11px">Permit applicants / contractors (${c.permitContacts.length})</b>
          ${c.permitContacts.length ? c.permitContacts.map((x) => `<div class="card" style="padding:7px 10px;font-size:11px;margin-top:4px">
            <div style="display:flex;justify-content:space-between"><b>${h(x.name || x.business || "—")}</b>${x.phone ? `<a href="tel:${x.phone}" style="font-weight:700">${h(x.phone)}</a>` : ""}</div>
            <div class="note">${h([x.business, x.role, x.date].filter(Boolean).join(" · "))}</div></div>`).join("") : `<p class="note" style="margin:3px 0 0">No permit contacts on file for this lot.</p>`}
        </div>
        ${c.ownerEntities.length ? `<div><b style="font-size:11px">LLC / entity principals (state filing)</b>
          ${c.ownerEntities.map((x) => `<div class="card" style="padding:7px 10px;font-size:11px;margin-top:4px"><b>${h(x.entityName)}</b>${x.address ? `<div class="note"><span style="color:var(--ink-faint)">Service address: </span>${h(x.address)}</div>` : ""}<div class="note">${h([x.entityType, x.county ? `${x.county} County` : null, x.dosId ? `DOS ${x.dosId}` : null].filter(Boolean).join(" · "))}</div></div>`).join("")}</div>` : ""}
        ${c.debtParties.length ? `<div><b style="font-size:11px">Debt parties (recorded)</b>
          ${c.debtParties.map((x) => `<div class="card" style="padding:7px 10px;font-size:11px;margin-top:4px"><b>${h(x.name ?? "—")}</b><div class="note">${h(/borrower/i.test(x.role ?? "") ? "Borrower / Sponsor" : x.role)}</div></div>`).join("")}</div>` : ""}
        <p class="note">${h(c.note ?? "")}</p>
      </div>`;
  } catch {
    target.innerHTML += `<div class="callout red" style="margin-top:6px">Contacts pull failed. Try Refresh.</div>`;
  }
}

async function loadLive(container, b) {
  const target = el("#bd-live", container);
  target.innerHTML = `<span class="eyebrow dim">Live Records — Drill Down</span><div style="padding:8px 0">${spinner("Pulling live public records for this lot…")}</div>`;
  try {
    const qs = new URLSearchParams({ bbl: b.bbl, borough: String(b.borough), block: String(b.block), lot: String(b.lot), address: b.address, area: b.zip ?? "" });
    const live = await api(`/api/livepull?${qs}`);
    const src = (id) => live.sources.find((s) => s.id === id)?.rows ?? [];
    const section = (title, rows, fields, filename) => `
      <details class="card" style="padding:0;overflow:hidden">
        <summary style="padding:9px 12px;font-size:12px;font-weight:650;cursor:pointer">${h(title)} <span class="note">(${rows.length})</span></summary>
        <div style="padding:0 12px 10px">
          ${rows.length ? `<div style="display:flex;justify-content:flex-end;margin-bottom:5px"><button class="btn sm" data-exp="${filename}">Export CSV</button></div>` : ""}
          ${rows.length ? rows.slice(0, 12).map((r) => `<div class="card" style="padding:7px 9px;margin-bottom:4px;font-size:10.5px;display:grid;grid-template-columns:1fr 1fr;gap:2px 12px">
            ${fields.map(([label, keys]) => { const v = keys.map((k) => r[k]).find((x) => x != null && x !== ""); return `<span style="display:flex;justify-content:space-between;gap:6px"><span style="color:var(--ink-faint)">${label}</span><b style="text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(String(v ?? "—"))}</b></span>`; }).join("")}
          </div>`).join("") : `<p class="note">No records returned for this lot.</p>`}
        </div>
      </details>`;
    const sections = [
      { title: "Recorded sales", rows: src("rolling_sales"), fields: [["Date", ["sale_date"]], ["Price", ["sale_price"]], ["Class", ["building_class_at_present"]], ["Gross sf", ["gross_square_feet"]]], file: `sales_${b.bbl}` },
      { title: "Permit issuance", rows: src("dob_permits"), fields: [["Issued", ["issuance_date"]], ["Job type", ["job_type"]], ["Status", ["permit_status"]], ["Applicant", ["applicant_business_name"]]], file: `dob_permits_${b.bbl}` },
      { title: "Recent filings", rows: src("dob_now"), fields: [["Filed", ["filing_date"]], ["Job", ["job_type"]], ["Status", ["filing_status"]], ["Applicant", ["applicant_business"]]], file: `dob_now_${b.bbl}` },
      { title: "Recorded mortgages & satisfactions", rows: live.debt.rows ?? src("acris_master"), fields: [["Doc type", ["doc_type"]], ["Amount", ["document_amt"]], ["Recorded", ["recorded_datetime"]], ["Doc ID", ["document_id"]]], file: `acris_debt_${b.bbl}` },
      { title: "ZAP zoning applications", rows: src("zap"), fields: [["Project", ["project_name"]], ["Status", ["current_status"]], ["Brief", ["project_brief"]]], file: `zap_${b.bbl}` }
    ];
    target.innerHTML = `<span class="eyebrow dim">Live Records — Drill Down (Permits · Ownership · Sales)</span>
      <p class="note" style="margin:6px 0">Click a section to drill into the underlying public records; Export pulls them to CSV.</p>
      <div style="display:grid;gap:6px">${sections.map((s) => section(s.title, s.rows, s.fields, s.file)).join("")}</div>
      ${live.debt.found ? `<div class="callout blue" style="margin-top:7px;padding:8px 11px;font-size:11px"><b>Latest debt:</b> ${h(live.debt.docTypeLabel ?? "")} · ${usd(live.debt.amount)} · Lender ${h(live.debt.lender ?? "—")} · Borrower ${h(live.debt.borrower ?? "—")}</div>` : ""}
      <p class="note" style="margin-top:7px">Pulled ${new Date(live.fetchedAt).toLocaleString()} from public records.</p>`;
    els("[data-exp]", target).forEach((btn) => btn.addEventListener("click", (e) => {
      e.preventDefault();
      const s = sections.find((x) => x.file === btn.dataset.exp);
      if (!s || !s.rows.length) return;
      const cols = Object.keys(s.rows[0]).map((k) => ({ header: k, value: (r) => r[k] }));
      exportCsv(s.file, cols, s.rows);
    }));
  } catch {
    target.innerHTML += `<div class="callout red" style="margin-top:6px">Live pull failed. Full parcel detail above is still available.</div>`;
  }
}
