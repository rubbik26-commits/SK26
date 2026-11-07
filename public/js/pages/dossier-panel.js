// The curated-parcel dossier panel: investment justification, score breakdown,
// live data pull evidence tiles, contacts, so-what call angle, qualifiers,
// evidence spine, risk flags, official record links and diligence framework.
import { api } from "../api.js";
import { el, els, h, scorePill, categoryBadge, riskBadge, fitBadge, pillBadge, kvRow, spinner, toast, icons } from "../ui.js";
import { sf, num, dateShort } from "../lib/format.js";
import { govLinks } from "../lib/constants.js";
import {
  scoreBreakdown, justification, qualifiers, evidenceSpine, contactStrategy,
  soWhatBlock, diligenceFramework, precisionLabel, precisionDetail, bblDigits, isExactAddress
} from "../lib/intel.js";

export async function renderDossierPanel(container, p, { fresh = false } = {}) {
  const j = justification(p);
  const sb = scoreBreakdown(p);
  const so = soWhatBlock(p);
  const digits = bblDigits(p);
  const links = govLinks(digits, p.block, p.lot);
  const exact = isExactAddress(p);

  container.innerHTML = `
    <div style="padding:15px 16px;border-bottom:1px solid var(--line)">
      <div style="display:flex;gap:11px;align-items:flex-start">
        ${scorePill(p.opportunityScore, 44)}
        <div style="min-width:0;flex:1">
          <h2 style="margin:0;font-size:15px;font-weight:750;line-height:1.2">${h(p.address)}</h2>
          <p class="note" style="margin-top:2px"><span class="mono">${h(p.id)}</span> · ${h(p.neighborhood)}</p>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px">
        ${categoryBadge(p.category)} ${riskBadge(p.risk)} ${fitBadge(p.conversionFit)}
        <span class="badge" style="${exact ? "background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line)" : "background:var(--red-soft);color:var(--red);border-color:currentColor"}">${h(precisionLabel(p))}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:11px">
        <a class="btn primary" style="justify-content:center" href="#/dossier?bbl=${digits}&addr=${encodeURIComponent(p.address)}&nb=${encodeURIComponent(p.neighborhood)}">${icons.file} Full Dossier →</a>
        <a class="btn" style="justify-content:center" href="#/calculator?calcAddr=${encodeURIComponent(p.address)}&calcBbl=${digits}&calcSf=${p.bldgSf || ""}&calcLot=${p.lotSf || ""}&calcBuildable=${p.unbuiltFarSf || ""}">${icons.calc} Analyze deal →</a>
      </div>
    </div>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span class="eyebrow dim">Investment Justification</span>${pillBadge(j.tier)}
      </div>
      <div class="callout blue"><p style="margin:0;font-weight:550">${h(j.thesis)}</p></div>
      <p class="eyebrow dim" style="margin:10px 0 5px">What drives the case</p>
      <ul style="margin:0;padding-left:16px;display:grid;gap:4px">${j.drivers.map((d) => `<li style="font-size:11.5px;line-height:1.5">${h(d)}</li>`).join("")}</ul>
      <p class="note" style="font-style:italic;margin-top:8px">${h(j.caveat)}</p>
    </section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span class="eyebrow dim">Score Breakdown</span><b style="color:var(--accent-ink);font-size:12.5px">${sb.total}/100</b>
      </div>
      <div style="display:grid;gap:6px">
        ${sb.components.map((c) => `
          <div class="card" style="padding:8px 10px;border-radius:9px">
            <div style="display:flex;justify-content:space-between;font-size:11.5px"><b>${h(c.label)}</b><span class="tabular" style="color:var(--accent-ink);font-weight:700">+${c.points}<span style="color:var(--ink-faint);font-weight:400"> / ${c.max}</span></span></div>
            <div style="height:5px;border-radius:4px;background:var(--bg-sunken);margin:5px 0;overflow:hidden"><div style="height:100%;width:${c.max ? Math.min(100, (c.points / c.max) * 100) : 0}%;background:var(--accent);border-radius:4px"></div></div>
            <p class="note" style="margin:0">${h(c.rationale)}</p>
          </div>`).join("")}
      </div>
      <p class="note" style="margin-top:8px">${h(sb.interpretation)}</p>
    </section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Live Validation Posture</span>
      <div class="callout ${exact ? "blue" : "red"}" style="margin-top:7px"><b>${h(precisionLabel(p))}</b><p class="note" style="margin:4px 0 0">${h(precisionDetail(p))}</p></div>
    </section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)" id="dp-live"></section>

    ${p.policyCatalysts.length ? `<section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Policy Catalysts</span>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:7px">${p.policyCatalysts.map((c) => pillBadge(c)).join("")}</div>
    </section>` : ""}

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Parcel & Land Use</span>
      <div style="margin-top:6px">
        ${kvRow("BBL", h(p.bbl), true)}${kvRow("BIN", p.bin === "0000000" ? "— (vacant/lot)" : h(p.bin), true)}
        ${kvRow("Block / Lot", `${p.block} / ${p.lot}`, true)}${kvRow("Zoning", h(p.zoning))}
        ${kvRow("Land use", h(p.landUse))}${kvRow("Lot area", sf(p.lotSf))}${kvRow("Building area", sf(p.bldgSf))}
        ${kvRow("Built FAR / Max", `${p.far.toFixed(1)} / ${p.maxFar.toFixed(1)}`, true)}
        ${kvRow("Unused FAR", p.unbuiltFarSf ? sf(p.unbuiltFarSf) : "—")}
        ${kvRow("Year built", String(p.yearBuilt), true)}${kvRow("Floors", String(p.floors), true)}
        ${kvRow("Est. land $/bsf", p.estLandPpbsf ? `$${p.estLandPpbsf}` : "—", true)}
      </div>
      <div style="margin-top:9px"><span class="eyebrow dim">Ownership</span>
        <p style="font-size:12.5px;font-weight:650;margin:5px 0 2px">${h(p.owner)}</p>
        <p class="note" style="margin:0">${h(p.ownerNote)}</p></div>
    </section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)" id="dp-contacts"></section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">So What — Client Call Angle</span>
      <div class="callout blue" style="margin:7px 0 9px"><b style="font-size:12px">${h(so.soWhat)}</b></div>
      <p class="eyebrow dim" style="margin:0 0 4px">Why it matters</p>
      <ul style="margin:0;padding-left:16px;display:grid;gap:3px">${so.whyItMatters.map((w) => `<li style="font-size:11.5px;line-height:1.5">${h(w)}</li>`).join("")}</ul>
      <div class="card" style="padding:9px 11px;margin-top:8px"><p class="eyebrow dim" style="margin:0 0 3px">Outreach hook</p><p style="margin:0;font-size:11.5px;font-style:italic">${h(so.outreachHook)}</p></div>
      <div style="display:grid;gap:7px;margin-top:7px">
        <div class="card" style="padding:9px 11px"><p class="eyebrow dim" style="margin:0 0 3px">Likely objection</p><p style="margin:0;font-size:11.5px">${h(so.likelyObjection)}</p></div>
        <div class="card" style="padding:9px 11px"><p class="eyebrow dim" style="margin:0 0 3px">Response</p><p style="margin:0;font-size:11.5px">${h(so.response)}</p></div>
      </div>
      <div class="callout blue" style="margin-top:8px"><p class="eyebrow" style="margin:0 0 3px">Recommended ask / next step</p><p style="margin:0;font-size:12px">${h(so.recommendedAsk)}</p></div>
    </section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Conversion / Development Thesis</span>
      <p style="font-size:12.5px;line-height:1.6;margin:6px 0 0">${h(p.thesis)}</p>
    </section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Opportunity Qualifiers</span>
      <div style="display:grid;gap:7px;margin-top:7px">
        ${qualifiers(p).map((q) => `<div class="card" style="padding:9px 11px">
          <div style="display:flex;justify-content:space-between;gap:10px"><b style="font-size:11.5px;color:var(--ink-faint)">${h(q.title)}</b><b style="font-size:11.5px;color:var(--accent-ink);text-align:right">${h(q.value)}</b></div>
          <p style="margin:5px 0 0;font-size:11.5px;line-height:1.5">${h(q.detail)}</p></div>`).join("")}
      </div>
    </section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)" id="dp-spine"></section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Risk Flags</span>
      <ul style="margin:6px 0 0;padding-left:16px;display:grid;gap:3px">${p.riskFlags.map((r) => `<li style="font-size:12px">${h(r)}</li>`).join("")}</ul>
      <p class="eyebrow dim" style="margin:11px 0 3px">Recommended next action</p>
      <p style="margin:0;font-size:12.5px">${h(p.nextAction)}</p>
    </section>

    <section style="padding:13px 16px;border-bottom:1px solid var(--line)">
      <span class="eyebrow dim">Live Public Source Checks</span>
      <div style="display:grid;gap:6px;margin-top:7px">
        ${sourceChecks(links).map((s) => `<a class="card" style="padding:9px 11px;display:block" href="${s.url}" target="_blank" rel="noopener">
          <span style="display:flex;justify-content:space-between;font-size:11.5px;font-weight:650">${h(s.label)} ${icons.external}</span>
          <span class="note" style="display:block;margin-top:3px">${h(s.check)}</span></a>`).join("")}
      </div>
      <p class="note" style="margin-top:8px">The Live Data Pull above queries these public sources automatically by borough/block/lot; these links open the same systems for the deal file.</p>
    </section>

    <section style="padding:13px 16px">
      <span class="eyebrow dim">Full Diligence Memo Framework</span>
      <div style="display:grid;gap:8px;margin-top:7px">
        ${diligenceFramework(p).map((d) => `<div class="card" style="padding:10px 12px">
          <b style="font-size:12px">${h(d.title)}</b>
          <ul style="margin:6px 0 0;padding-left:15px;display:grid;gap:4px">${d.items.map((i) => `<li style="font-size:11.5px;line-height:1.5">${h(i)}</li>`).join("")}</ul></div>`).join("")}
      </div>
    </section>`;

  renderLivePull(el("#dp-live", container), p, links, fresh);
}

function sourceChecks(links) {
  return [
    { label: "Recorded documents — sales, deeds & mortgages (this BBL)", url: links.acris, check: "Opens the recorded-document record for this exact lot: deeds, sale prices, mortgages, lien signals, and entity transfers." },
    { label: "NYC Property Information Portal (this parcel)", url: links.propPortal, check: "Opens the official parcel page: BBL, lot/building area, zoning, land use, owner, assessment, year built, taxes." },
    { label: "Buildings — property profile (this lot)", url: links.bisweb, check: "Opens the buildings profile: permits, jobs, work type, filing dates, status, applicant, complaints, and violations." },
    { label: "Zoning map — zoning, overlays & flood (this lot)", url: links.zola, check: "Opens the zoning map zoomed to this lot: district, overlays, special districts, MIH, flood, landmark, E-designation." }
  ];
}

async function renderLivePull(target, p, links, fresh) {
  target.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
    <span class="eyebrow dim">Live Data Pull</span><span>${spinner("Pulling live public records…")}</span></div>`;
  const digits = bblDigits(p);
  const qs = new URLSearchParams({ bbl: digits, block: String(p.block), lot: String(p.lot), borough: digits[0], address: p.address });
  if (p.bin && p.bin !== "0000000") qs.set("bin", p.bin);
  let live = null;
  try { live = await api(`/api/livepull?${qs}`, { fresh }); } catch { /* renders below */ }
  const spineTarget = el("#dp-spine", target.closest(".drawer-body") ?? target.parentElement ?? document);
  if (spineTarget) {
    spineTarget.innerHTML = `<span class="eyebrow dim">Deep Intelligence Spine</span>
      <div style="display:grid;gap:8px;margin-top:7px">
      ${evidenceSpine(p, live, links).map((t) => `<div class="card" style="padding:10px 12px">
        <div style="display:flex;justify-content:space-between;gap:8px"><div><b style="font-size:12px">${h(t.title)}</b><div class="note">${h(t.source)}</div></div>${pillBadge(t.status)}</div>
        <p style="margin:6px 0 0;font-size:11.5px;line-height:1.5">${h(t.detail)}</p>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${t.fields.map((f) => `<span class="badge" style="background:var(--bg-sunken);color:var(--ink-soft);border-color:var(--line);text-transform:none;letter-spacing:0">${h(f)}</span>`).join("")}</div>
        <div style="display:flex;gap:6px;margin-top:7px">${t.links.map((l) => `<a class="btn sm ghost" href="${l.url}" target="_blank" rel="noopener">${h(l.label)} ${icons.external}</a>`).join("")}</div>
      </div>`).join("")}</div>`;
  }
  const contactsTarget = el("#dp-contacts", target.closest(".drawer-body") ?? document);
  if (contactsTarget) {
    const contacts = contactStrategy(p, live?.debt, live?.permitContact, live?.plutoOwner);
    contactsTarget.innerHTML = `<span class="eyebrow dim">Contact Targets</span>
      <div style="display:grid;gap:7px;margin-top:7px">
      ${contacts.map((c) => `<div class="card" style="padding:9px 11px">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><b style="font-size:11.5px">${h(c.role)}</b>
          <span class="badge" style="${c.confidence.startsWith("Pulled") ? "background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line)" : "background:var(--amber-soft);color:var(--amber);border-color:currentColor"}">${h(c.confidence)}</span></div>
        <p style="margin:5px 0 0;font-size:11.5px;line-height:1.5">${h(c.target)}</p>
        <p class="note" style="margin:4px 0 0">${h(c.rationale)}</p>
        <p class="note" style="margin:4px 0 0"><b>Source / next step:</b> ${h(c.verify)}</p>
      </div>`).join("")}</div>
      <p class="note" style="margin-top:7px">Demo record — names/contacts are unverified. Treat as a research target and confirm before any outreach.</p>`;
  }
  if (!live) {
    target.innerHTML = `<span class="eyebrow dim">Live Data Pull</span><div class="callout red" style="margin-top:7px">Live pull failed. The dossier still works from modeled data.</div>`;
    return;
  }
  const s = live.summary;
  const tiles = [
    { key: "sale", label: "Last recorded sale", value: s.lastSale?.saleDate ? `${s.lastSale.saleDate.slice(0, 10)} · $${num(s.lastSale.salePrice)}` : "No live sale" },
    { key: "parcel", label: "Parcel match", value: s.parcelMatch.replace("-", " ") },
    { key: "dob", label: "Permit activity", value: `${s.dobPermitCount} permits · ${s.dobNowCount} filings` },
    { key: "zap", label: "ZAP zoning activity", value: `${s.zoningApplicationCount} applications` },
    { key: "debt", label: "Recorded debt (mortgagee)", value: live.debt.found ? live.debt.lender ?? `${s.debtDocCount} docs` : "No live debt" }
  ];
  target.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span class="eyebrow dim">Live Data Pull</span>
      <button class="btn sm ghost" data-lp-refresh title="Re-pull live evidence for the selected parcel">${icons.refresh} Refresh live data</button>
    </div>
    <p class="note" style="color:var(--accent-ink);margin:0 0 8px">Live evidence refreshes on open, tile click, or Refresh. Click any tile for the underlying public-data evidence.</p>
    <div class="callout ${live.mode === "exact" ? "blue" : "amber"}" style="padding:8px 11px;font-size:11px"><b>${live.mode === "exact" ? "Exact parcel pull" : "Block-level pull"}:</b> ${h(live.coverage)}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px">
      ${tiles.map((t) => `<button class="card" data-tile="${t.key}" style="text-align:left;padding:8px 10px">
        <div class="note" style="display:flex;justify-content:space-between">${h(t.label)} <span>▾</span></div>
        <div style="font-size:12px;font-weight:650;margin-top:2px">${h(t.value)}</div></button>`).join("")}
    </div>
    <div id="lp-evidence" style="margin-top:8px"></div>
    <p class="note" style="margin-top:8px">Pulled ${new Date(live.fetchedAt).toLocaleString()} from public records (${s.okSources} sources returned rows, ${s.errorSources} errored). Demo BBL/BIN may not match a live record — empty results mean the modeled identifier has no live filing, not that the system failed.</p>`;
  el("[data-lp-refresh]", target).addEventListener("click", () => renderLivePull(target, p, links, true));
  els("[data-tile]", target).forEach((b) => b.addEventListener("click", () => {
    els("[data-tile]", target).forEach((x) => (x.style.borderColor = ""));
    b.style.borderColor = "var(--accent-line)";
    el("#lp-evidence", target).innerHTML = evidenceRows(b.dataset.tile, live);
  }));
}

function evidenceRows(kind, live) {
  const src = (id) => live.sources.find((s) => s.id === id);
  const row = (obj, fields) => `<div class="card" style="padding:7px 10px;font-size:10.5px;margin-bottom:5px">
    ${fields.map(([k, keys]) => { const v = keys.map((x) => obj[x]).find((x) => x != null && x !== ""); return v == null ? "" : `<span style="margin-right:10px"><span style="color:var(--ink-faint)">${k}:</span> <b>${h(String(v))}</b></span>`; }).join("")}</div>`;
  const empty = (msg) => `<div class="card" style="padding:9px 11px;font-size:11px;color:var(--ink-faint)">${h(msg)}</div>`;
  if (kind === "sale") {
    const rows = src("rolling_sales")?.rows ?? [];
    return rows.length ? rows.slice(0, 8).map((r) => row(r, [["Date", ["sale_date"]], ["Price", ["sale_price"]], ["Class", ["building_class_at_present"]], ["Gross sf", ["gross_square_feet"]]])).join("") : empty("No arm's-length sale is recorded on this borough/block/lot. For a demo BBL this is expected; on a real lot it means no arm's-length sale in the rolling window.");
  }
  if (kind === "parcel") {
    const r = src("pluto")?.rows?.[0];
    return r ? [["BBL", "bbl"], ["Address", "address"], ["Zoning", "zonedist1"], ["Land use", "landuse"], ["Lot area", "lotarea"], ["Bldg area", "bldgarea"], ["Built FAR", "builtfar"], ["Year built", "yearbuilt"], ["Owner (record)", "ownername"]].map(([k, f]) => kvRow(k, h(String(r[f] ?? "—")))).join("") : empty("BBL not found in the public record — the modeled identifier does not resolve to a live tax lot (expected for demo data).");
  }
  if (kind === "dob") {
    const rows = [...(src("dob_permits")?.rows ?? []), ...(src("dob_now")?.rows ?? [])];
    return rows.length ? rows.slice(0, 10).map((r) => row(r, [["Type", ["job_type", "work_type"]], ["Status", ["permit_status", "filing_status"]], ["Date", ["issuance_date", "filing_date"]], ["Applicant", ["applicant_business_name", "applicant_business"]]])).join("") : empty("No permit issuance or job filings returned for this BIN/BBL (expected for a demo identifier or a lot with no recent filings).");
  }
  if (kind === "zap") {
    const rows = src("zap")?.rows ?? [];
    return rows.length ? rows.map((r) => row(r, [["Project", ["project_name", "ulurp_number"]], ["Status", ["current_status", "project_status"]], ["Brief", ["project_brief"]]])).join("") : empty("No City Planning ZAP zoning application is linked to this BBL (expected for a demo identifier or a lot with no active land-use action).");
  }
  if (kind === "debt") {
    if (!live.debt.found) return empty("No recorded debt document (mortgage/assignment/satisfaction) resolved for this borough/block/lot (expected for a demo BBL or an unencumbered lot).");
    const rows = live.debt.rows ?? [];
    return `<div class="callout blue" style="padding:8px 11px;font-size:11px;margin-bottom:6px"><b>${h(live.debt.docTypeLabel ?? live.debt.docType)} — $${num(live.debt.amount)}</b><br/>Lender: ${h(live.debt.lender ?? "—")} · Borrower: ${h(live.debt.borrower ?? "—")}<br/>Recorded ${dateShort(live.debt.recordedDate)} · doc ${h(live.debt.documentId ?? "—")}</div>` +
      rows.slice(0, 10).map((r) => row(r, [["Type", ["doc_type"]], ["Amount", ["document_amt"]], ["Recorded", ["recorded_datetime"]]])).join("");
  }
  return "";
}
