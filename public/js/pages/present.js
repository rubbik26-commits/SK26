// Presentation Mode — the client tour: hero, why-this-geography, Top-5 with
// lens toggle, and data provenance.
import { api } from "../api.js";
import { el, els, h, scorePill, categoryBadge, icons } from "../ui.js";
import { sf } from "../lib/format.js";

const LENSES = [
  { id: "top", label: "Top conviction", blurb: "Highest opportunity scores across the NYC coverage set." },
  { id: "multifamily", label: "Multifamily", blurb: "Brooklyn, LIC/Queens, and infill rental candidates." },
  { id: "adaptive", label: "Adaptive reuse / 467-m", blurb: "Office-to-residential conversion candidates." },
  { id: "land", label: "Density & land", blurb: "Most unused FAR — ground-up & assemblage upside." }
];
let lens = "top";

export async function mount(root) {
  const [seeds, sources] = await Promise.all([api("/api/opportunities"), api("/api/sources").catch(() => [])]);
  root.innerHTML = `<div class="scroll" style="height:100%" id="pz"></div>`;
  render();
  function pickTop() {
    let list = [...seeds];
    if (lens === "multifamily") list = list.filter((p) => p.category === "Multifamily Candidate");
    if (lens === "adaptive") list = list.filter((p) => p.adaptiveReuse);
    if (lens === "land") list.sort((a, b) => b.unbuiltFarSf - a.unbuiltFarSf);
    else list.sort((a, b) => b.opportunityScore - a.opportunityScore);
    return list.slice(0, 5);
  }
  function render() {
    const mf = seeds.filter((p) => p.category === "Multifamily Candidate").length;
    el("#pz").innerHTML = `
      <div class="hero-band">
        <div style="display:flex;align-items:center;gap:10px">${icons.logo(24)}<span class="eyebrow">Client Tour · NYC Dev Intelligence</span></div>
        <h1>Block-by-block Market Intel for NYC multifamily and development.</h1>
        <p class="sub" style="max-width:640px;margin-top:10px">The platform covers the same disciplined parcel workflow across <b style="color:var(--ink)">Brooklyn, LIC/Queens, and Manhattan</b> — multifamily candidates, development sites, assemblages, active builds, and adaptive-reuse candidates on one live-map canvas.</p>
        <div style="display:flex;flex-wrap:wrap;gap:28px;margin-top:22px">
          ${[[String(seeds.length), "Sites tracked", false], [String(mf), "Multifamily candidates", true], ["3", "Primary markets", false], ["44", "NYC conversions (Comptroller)", true]]
            .map(([v, l, a]) => `<div><div style="font-size:24px;font-weight:800;color:${a ? "var(--accent-ink)" : "var(--ink)"}" class="tabular">${v}</div><div class="eyebrow dim" style="margin-top:2px">${h(l)}</div></div>`).join("")}
        </div>
      </div>
      <div style="max-width:960px;margin:0 auto;padding:26px 22px 70px">
        <div class="sect-head"><span class="t">Why this geography & asset focus</span></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:11px">
          ${[["Policy tailwinds are live", "467-m, City of Yes, Gowanus, and OneLIC give the platform live policy catalysts across conversion, ground-up, and mixed-income multifamily."],
            ["Brooklyn + LIC/Queens repeat", "The multifamily layer repeats the same underwriting lens: unused FAR, transit access, zoning catalyst, ownership complexity, construction risk, and comp basis."],
            ["Public records make it knowable", "Public tax-lot, permit, ownership, and zoning records let us model every parcel block-by-block before anyone calls a broker."]]
            .map(([t, b]) => `<div class="card card-pad"><b style="font-size:13px">${h(t)}</b><p class="sub" style="margin-top:5px">${h(b)}</p></div>`).join("")}
        </div>
        <div class="sect-head" style="margin-top:26px"><span class="t">Top 5 opportunities</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <div class="pill-toggle">${LENSES.map((l) => `<button class="${lens === l.id ? "on" : ""}" data-lens="${l.id}">${h(l.label)}</button>`).join("")}</div>
          <span class="note">${h(LENSES.find((l) => l.id === lens).blurb)}</span>
        </div>
        <div style="display:grid;gap:9px">
          ${pickTop().map((p, i) => `
            <a class="card" style="display:flex;gap:14px;align-items:center;padding:12px 14px;text-decoration:none;color:inherit" href="#/dossier?bbl=${p.bbl.replace(/[^0-9]/g, "")}&addr=${encodeURIComponent(p.address)}">
              <span style="font-size:20px;font-weight:800;color:var(--ink-faint);width:22px" class="tabular">${i + 1}</span>
              ${scorePill(p.opportunityScore, 40)}
              <div style="min-width:0;flex:1">
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="font-size:14px">${h(p.address)}</b>${categoryBadge(p.category, true)}
                  ${lens === "land" && p.unbuiltFarSf > 0 ? `<span class="badge" style="background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line)">${sf(p.unbuiltFarSf)} unused FAR</span>` : ""}</div>
                <p class="note" style="margin:2px 0 0">${h(p.neighborhood)} · ${h(p.zoning)}</p>
                <p style="margin:6px 0 0;font-size:12px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${h(p.thesis)}</p>
              </div><span style="color:var(--ink-faint)">›</span>
            </a>`).join("")}
        </div>
        <div class="sect-head" style="margin-top:26px"><span class="t">Data provenance</span></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:9px">
          ${(sources ?? []).map((s) => `<div class="card" style="padding:10px 13px"><b style="font-size:12px">${h(s.publisher)}</b><p class="note" style="margin:3px 0 0">${h(s.powers)}</p></div>`).join("")}
        </div>
        <p class="note" style="margin-top:16px;max-width:760px">Site-level records are public-data-shaped targets. Exact-address records are live-ready for reconciliation; corridor, vicinity, and assemblage records must be narrowed to precise BBLs before they can be treated as validated acquisition opportunities.</p>
      </div>`;
    els("[data-lens]").forEach((b) => b.addEventListener("click", () => { lens = b.dataset.lens; render(); }));
  }
  return {};
}
