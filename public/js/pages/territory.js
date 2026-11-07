// Territory Mastery — "Know Your Market Better Than Anyone Alive."
// Territory search, live area intelligence (census / pipeline / top assets /
// ownership), authored histories, cold-call system, weekly cadence.
import { api } from "../api.js";
import { el, els, h, statCard, spinner, openModal, openDocumentPreview, kvRow, toast } from "../ui.js";
import { num, usd, dateShort } from "../lib/format.js";
import { marketReportHtml } from "../lib/reports.js";

let TERRITORIES = null;
const state = { slug: null, mode: "multifamily", tab: "search" };

async function territories() {
  if (!TERRITORIES) {
    // The territory catalog ships with the server; mirror it via a tiny fetch of a static list endpoint (reuse /api/opportunities pattern is overkill — inline import via /js not possible), so fetch once from a JSON view.
    TERRITORIES = await api("/api/territories");
  }
  return TERRITORIES;
}

export async function mount(root) {
  const list = await territories();
  root.innerHTML = `<div class="scroll" style="height:100%" id="tm-root"></div>`;
  render();

  function current() { return list.find((t) => t.slug === state.slug) ?? null; }

  function render() {
    const t = current();
    const tabs = [
      ["search", "Territory Search"], ["area", t ? `${t.label} Intel` : "Area Intel"],
      ["coldcall", "Cold-Call System"], ["cadence", "Weekly Cadence"]
    ];
    el("#tm-root").innerHTML = `
      <div class="masthead">
        <div class="eyebrow" style="color:hsl(203 95% 70%)">Territory Mastery</div>
        <h1>Know Your Market<br/><em>Better Than Anyone Alive.</em></h1>
        <p class="sub">Search any NYC neighborhood for a live intelligence dossier — census, pricing, ownership, top assets, and full history — wired to live public records so the numbers never go stale.</p>
      </div>
      <nav class="tab-nav">${tabs.map(([k, l]) => `<button class="tab-btn ${state.tab === k ? "on" : ""}" data-tab="${k}">${h(l)}</button>`).join("")}</nav>
      <div id="tm-body" style="max-width:940px;margin:0 auto;padding:30px 22px 70px"></div>`;
    els("[data-tab]").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; render(); }));
    const body = el("#tm-body");
    if (state.tab === "search") renderSearch(body);
    else if (state.tab === "area") t ? renderArea(body, t) : renderPickFirst(body, "area intelligence");
    else if (state.tab === "coldcall") t ? renderColdCall(body, t) : renderPickFirst(body, "cold-call hooks");
    else renderCadence(body, t?.label ?? "your market");
  }

  function chips() {
    return `<div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:8px">
      ${list.filter((t) => ["Manhattan", "Brooklyn", "Queens"].includes(t.borough)).sort((a, b) => a.borough.localeCompare(b.borough) || a.label.localeCompare(b.label))
        .map((t) => `<button class="chip" data-terr="${t.slug}" style="${t.history ? "font-weight:750;border-color:var(--accent-line)" : ""}">${h(t.label)}</button>`).join("")}
    </div>`;
  }
  function wireChips(scope) {
    els("[data-terr]", scope).forEach((b) => b.addEventListener("click", () => {
      const t = list.find((x) => x.slug === b.dataset.terr);
      state.slug = t.slug; state.mode = t.defaultMode ?? "multifamily"; state.tab = "area";
      render();
    }));
  }
  function searchBox(scope, inputId) {
    const go = () => {
      const q = el(`#${inputId}`, scope).value.trim();
      const t = list.find((x) => x.slug === q.toLowerCase()) ??
        list.find((x) => x.label.toLowerCase() === q.toLowerCase()) ??
        list.find((x) => x.keywords?.some((k) => k === q.toLowerCase() || k.includes(q.toLowerCase()) || q.toLowerCase().includes(k))) ??
        list.find((x) => x.zips.includes((q.match(/\b\d{5}\b/) ?? [])[0]));
      if (!t) return toast(`No match for "${q}". Try a neighborhood (Chelsea, Harlem, LIC) or a ZIP.`);
      state.slug = t.slug; state.mode = t.defaultMode ?? "multifamily"; state.tab = "area";
      render();
    };
    el(`#${inputId}`, scope).addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    el(`#${inputId}-go`, scope).addEventListener("click", go);
  }

  function renderSearch(body) {
    body.innerHTML = `
      <div class="eyebrow">The Foundation</div>
      <h2 style="font-size:24px;margin:4px 0 12px;letter-spacing:-.02em">Own the Data. Own the Market.</h2>
      <div class="quote">Know your market better. Know who owns the most buildings, who owns the most units, who sold the most, who bought the most. Know everything.</div>
      <div class="eyebrow" style="margin-top:28px">Search a Territory</div>
      <h2 style="font-size:19px;margin:4px 0 6px">Pick any NYC neighborhood.</h2>
      <p class="sub" style="max-width:640px">Type a neighborhood or ZIP — LIC, Midtown, Chelsea, Harlem, Williamsburg… — and get its live census, pricing, ownership, top assets, and full history.</p>
      <div style="display:flex;gap:8px;margin-top:12px;max-width:640px">
        <input id="tm-q" class="field" placeholder="Search a neighborhood or ZIP — e.g. Chelsea, Harlem, 11101" style="flex:1" />
        <button id="tm-q-go" class="btn primary">Open territory →</button>
      </div>
      ${chips()}
      <p class="note" style="margin-top:10px">Bold areas carry a full authored history; any other area still returns live data. ${list.length} areas mapped.</p>`;
    searchBox(body, "tm-q");
    wireChips(body);
  }
  function renderPickFirst(body, what) {
    body.innerHTML = `
      <div class="eyebrow">Pick a territory first</div>
      <h2 style="font-size:19px;margin:4px 0 6px">Search a neighborhood to load its ${h(what)}.</h2>
      <div style="display:flex;gap:8px;margin-top:12px;max-width:640px">
        <input id="tm-q2" class="field" placeholder="Search a neighborhood or ZIP — e.g. Chelsea, Harlem, 11101" style="flex:1" />
        <button id="tm-q2-go" class="btn primary">Open →</button>
      </div>${chips()}`;
    searchBox(body, "tm-q2");
    wireChips(body);
  }

  async function renderArea(body, t) {
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:flex-start">
        <div><div class="eyebrow">${h(t.borough)} · Territory Intelligence</div>
          <h2 style="font-size:24px;margin:3px 0 4px;letter-spacing:-.02em">${h(t.label)}</h2>
          ${t.tagline ? `<p class="sub" style="font-style:italic;border-left:3px solid var(--accent);padding-left:12px;max-width:560px">${h(t.tagline)}</p>` : ""}</div>
        <div class="pill-toggle" id="tm-modes">${[["multifamily", "Multifamily"], ["condo", "Condo"], ["office", "Office"], ["hotels", "Hotels"], ["development", "Development"], ["misc", "Other"]].map(([k, l]) => `<button class="${state.mode === k ? "on" : ""}" data-mode="${k}">${l}</button>`).join("")}</div>
      </div>
      <p class="note" style="margin-top:8px">ZIP ${t.zips.join(", ")}. <span id="tm-live-line"></span></p>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn" id="tm-refresh">↻ Refresh live data</button>
        <button class="btn primary" id="tm-report">▤ Market report</button>
      </div>
      <div id="tm-census" style="margin-top:22px">${spinner("Querying live records…")}</div>
      <div id="tm-hist"></div>
      <div id="tm-pipe" style="margin-top:8px"></div>
      <div id="tm-top"></div>
      <div id="tm-owners"></div>
      ${t.notableStory ? `<div class="sect-head"><span class="t">The Story</span></div>
        <div class="callout blue" style="display:flex;gap:12px"><span style="font-size:16px">★</span><div><b>${h(t.label)} — a story for the call</b><p class="note" style="margin:4px 0 0;font-size:12px;color:var(--ink-soft)">${h(t.notableStory)}</p></div></div>` : ""}`;
    els("[data-mode]", body).forEach((b) => b.addEventListener("click", () => { state.mode = b.dataset.mode; renderArea(body, t); }));
    el("#tm-refresh", body).addEventListener("click", () => loadArea(body, t, true));
    el("#tm-report", body).addEventListener("click", async () => {
      const [report, radar] = await Promise.all([
        api(`/api/market-report?zips=${t.zips.join(",")}`),
        api(`/api/area-buildings?zips=${t.zips.join(",")}&sort=propensity&pageSize=8`).then((r) => r.buildings.filter((b) => (b.propensity ?? 0) >= 18)).catch(() => [])
      ]);
      openDocumentPreview("Area Investment Sales Report", marketReportHtml({ label: t.label, zips: t.zips, borough: t.borough, ppsfHistory: t.ppsfHistory, history: t.history, assetClass: state.mode, report, radar }));
    });
    loadArea(body, t, false);
  }

  async function loadArea(body, t, fresh) {
    const zips = t.zips.join(",");
    let data, pipe;
    try {
      [data, pipe] = await Promise.all([
        api(`/api/territory?zips=${zips}&mode=${state.mode}`, { fresh }),
        api(`/api/pipeline?zips=${zips}`, { fresh })
      ]);
    } catch { el("#tm-census", body).innerHTML = `<div class="callout red">Could not load live data.</div>`; return; }
    el("#tm-live-line", body).innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:99px;background:var(--green);box-shadow:0 0 0 3px var(--green-soft);vertical-align:0"></span> Queried ${new Date(data.fetchedAt).toLocaleString()} · public property records (census & owners) · recorded citywide sales${data.sales.latestSaleDate ? ` — latest recorded sale ${data.sales.latestSaleDate}` : ""} (trailing 12-mo).`;
    const c = data.census, s = data.sales;
    const dev = state.mode === "development";
    const qLabel = state.mode === "multifamily" ? "20+ unit MF buildings" : state.mode === "condo" ? "Condo buildings" : state.mode === "office" ? "Office buildings" : state.mode === "hotels" ? "Hotel properties" : state.mode === "misc" ? "Other / commercial lots" : "Underbuilt parcels";
    el("#tm-census", body).innerHTML = `
      <div class="sect-head"><span class="t">The Census — Live from public records</span><span class="s">Every number, pulled now.</span></div>
      <p class="note" style="margin:0 0 8px">Click a section to drill into the underlying public records; Export pulls them to CSV/Excel.</p>
      <div class="statgrid">
        ${statCard({ value: num(c.qualifyingCount), label: qLabel, note: dev ? "Built-FAR < 1.5 on land zoned 3+ FAR." : `Live count across ${t.zips.length} ZIPs.`, tone: "gold", drill: true, attr: `data-drill="qualifying"` })}
        ${dev ? statCard({ value: c.topUnusedBuildableSf ? num(c.topUnusedBuildableSf) + " sf" : "—", label: "Unused buildable, top 12", note: "Sum of unbuilt as-of-right area.", tone: "gold", drill: true, attr: `data-drill="qualifying"` })
          : statCard({ value: num(c.totalUnits), label: state.mode === "hotels" ? "Total keys / units" : "Total residential units", note: "Sum across qualifying buildings.", drill: true, attr: `data-drill="qualifying"` })}
        ${statCard({ value: num(c.totalLots), label: "Total tax lots", note: "Every lot in the ZIP set, all uses." })}
        ${statCard({ value: usd(s.medianPpsf), label: `Median ${s.metric} (12-mo)`, note: "Live recorded sales, area-specific.", tone: "green", drill: true, attr: `data-drill="sales"` })}
        ${statCard({ value: usd(s.avgPpsf), label: `Average ${s.metric}`, note: `Across ${num(s.count)} live sales (12-mo).`, drill: true, attr: `data-drill="sales"` })}
        ${statCard({ value: num(s.count), label: "Sales, trailing 12-mo", note: "Recorded arm's-length sales in the area.", drill: true, attr: `data-drill="sales"` })}
      </div>`;
    els("[data-drill]", body).forEach((b) => b.addEventListener("click", () => openDrill(t, b.dataset.drill)));

    // Historical deep dive
    const histEl = el("#tm-hist", body);
    if (t.ppsfHistory || t.history) {
      const maxP = Math.max(...(t.ppsfHistory ?? []).map((x) => x.ppsf), s.medianPpsf ?? 0, 1);
      histEl.innerHTML = `
        <details class="card" style="margin-top:14px;overflow:hidden">
          <summary style="padding:12px 14px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;border-left:3px solid var(--accent)">Historical deep-dive — price trend & full neighborhood history</summary>
          <div style="padding:14px 16px">
            ${t.ppsfHistory ? `<p class="eyebrow dim" style="margin:0 0 6px">Sale $/sf, every ~5 years <span style="font-weight:400;text-transform:none;letter-spacing:0">— researched estimates (directional); current-year figure above is live</span></p>
              ${t.ppsfHistory.map((x) => `<div class="bar-row"><span class="t" style="width:42px">${x.year}</span><span class="track"><span class="fill" style="width:${Math.round((x.ppsf / maxP) * 100)}%;background:var(--rail)"></span></span><span class="val">$${x.ppsf.toLocaleString()}</span></div>`).join("")}
              ${s.medianPpsf != null ? `<div class="bar-row"><span class="t" style="width:42px;font-weight:800">Now</span><span class="track"><span class="fill" style="width:${Math.round((s.medianPpsf / maxP) * 100)}%;background:var(--green)"></span></span><span class="val" style="font-weight:800">$${num(s.medianPpsf)} <em style="color:var(--green);font-style:normal">live</em></span></div>` : ""}` : ""}
            ${t.established ? `<p class="eyebrow dim" style="margin:14px 0 4px">Established <span style="font-weight:400;text-transform:none;letter-spacing:0">${h(t.established)}</span></p>` : ""}
            ${(t.history ?? []).map((par) => `<p style="font-size:13px;line-height:1.7;margin:0 0 10px">${h(par)}</p>`).join("")}
            ${t.growth ? `<p class="eyebrow dim" style="margin:10px 0 4px">Growth trend</p><p style="font-size:13px;line-height:1.7;margin:0">${h(t.growth)}</p>` : ""}
          </div>
        </details>`;
    } else {
      histEl.innerHTML = `<div class="callout blue" style="margin-top:14px;display:flex;gap:10px"><span>📖</span><div><b>Deep history coming for ${h(t.label)}</b><p class="note" style="margin:3px 0 0">This area returns full live data now; the authored historical narrative and 5-year price series are being written next.</p></div></div>`;
    }

    // Development pipeline
    el("#tm-pipe", body).innerHTML = `
      <div class="sect-head"><span class="t">Development Pipeline — Live from city permit records</span><span class="s">what's actually being built · last ${pipe.windowMonths} months</span></div>
      <div class="statgrid">
        ${statCard({ value: num(pipe.counts.newBuilding), label: "New-building filings", note: "Ground-up development in the pipeline.", tone: "gold" })}
        ${statCard({ value: num(pipe.counts.proposedUnits), label: "Proposed units", note: "Across new-building filings." })}
        ${statCard({ value: num(pipe.counts.foundation), label: "Foundation filings", note: "Under construction (foundation stage).", tone: "green" })}
        ${statCard({ value: num(pipe.counts.demolition), label: "Demolition filings", note: "Sites being cleared — pre-development signal." })}
      </div>
      ${pipe.sites.length ? `<div class="table-wrap card" style="margin-top:6px"><table class="tbl">
        <thead><tr><th>Filed</th><th>Address</th><th>Stage</th><th class="r">Proposed units</th><th>Status</th></tr></thead>
        <tbody>${pipe.sites.slice(0, 14).map((sr) => `<tr>
          <td>${dateShort(sr.filingDate)}</td>
          <td><a href="#/dossier?bbl=${sr.bbl}&addr=${encodeURIComponent(sr.address)}">${h(sr.address)}</a><div class="note">${h(sr.applicant ?? "")}</div></td>
          <td><span class="badge" style="${sr.kind === "New Building" ? "background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line)" : sr.kind === "Foundation" ? "background:var(--green-soft);color:var(--green);border-color:currentColor" : "background:var(--amber-soft);color:var(--amber);border-color:currentColor"}">${h(sr.kind)}</span></td>
          <td class="r">${sr.proposedUnits ? num(sr.proposedUnits) : "—"}</td><td style="font-size:11px">${h(sr.status)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="note">No new-building, foundation, or demolition filings on record for this area in the window.</p>`}`;

    // Top assets
    el("#tm-top", body).innerHTML = `
      <div class="sect-head"><span class="t">${dev ? "Top underbuilt sites — live, ranked by dev score" : "Top buildings — live"}</span><span class="s">${dev ? "highest-conviction land plays" : "highest-density assets"}</span></div>
      <div class="table-wrap card"><table class="tbl">
        <thead>${dev
          ? `<tr><th>Address</th><th class="r">Lot sf</th><th class="r">Built / Max FAR</th><th class="r">Unused buildable</th><th class="r">Score</th></tr>`
          : `<tr><th>Address</th><th class="r">${state.mode === "office" || state.mode === "misc" ? "Building sf" : state.mode === "hotels" ? "Keys / units" : "Resi units"}</th><th class="r">Year built</th><th>Owner</th><th class="r">Score</th></tr>`}</thead>
        <tbody>${(data.top ?? []).map((b) => `<tr>
          <td><a href="#/dossier?bbl=${b.bbl}&addr=${encodeURIComponent(b.address)}">${h(b.address)}</a><div class="note">BBL ${b.bbl} · ${h(b.zoning ?? "—")}</div></td>
          ${dev ? `<td class="r">${num(b.lotArea)}</td><td class="r">${(b.builtFar ?? 0).toFixed(1)} / ${(b.maxFar ?? 0).toFixed(1)}</td><td class="r">${b.unusedFarSf ? num(b.unusedFarSf) + " sf" : "—"}</td>`
            : `<td class="r">${num(state.mode === "office" || state.mode === "misc" ? b.bldgArea : state.mode === "hotels" ? b.unitsTotal : b.unitsRes)}</td><td class="r">${b.yearBuilt || "—"}</td><td style="font-size:11.5px">${h(b.owner ?? "—")}</td>`}
          <td class="r"><span class="badge" style="${b.score >= 75 ? "background:var(--green-soft);color:var(--green)" : "background:var(--amber-soft);color:var(--amber)"};border-color:currentColor">${b.score}/100</span></td></tr>`).join("")}</tbody></table></div>`;

    // Owners
    const ownerTable = (title, rows, key) => `
      <div><p class="eyebrow dim" style="margin:0 0 4px">${title}</p>
      <div class="table-wrap card"><table class="tbl"><thead><tr><th>Owner (record entity)</th><th class="r">Buildings</th><th class="r">Units</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map((o) => `<tr><td><b>${h(o.name)}</b></td><td class="r" style="${key === "buildings" ? "font-weight:800" : ""}">${num(o.buildings)}</td><td class="r" style="${key === "units" ? "font-weight:800" : ""}">${num(o.units)}</td><td><button class="btn sm" data-owner="${h(o.name)}">Show ${o.buildings} →</button></td></tr>`).join("") : `<tr><td colspan="4" class="note">No grouped ownership returned.</td></tr>`}</tbody></table></div></div>`;
    el("#tm-owners", body).innerHTML = `
      <div class="sect-head"><span class="t">Who Owns ${h(t.label)} — Live from public records</span><span class="s">Biggest owners · by buildings &amp; by units</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px">
        ${ownerTable("Most buildings owned", data.ownersByBuildings ?? [], "buildings")}
        ${ownerTable("Most units owned", data.ownersByUnits ?? [], "units")}
      </div>
      <div class="callout blue" style="margin-top:12px;display:flex;gap:10px"><span>📋</span><div><b>Sellers & buyers (next layer)</b><p class="note" style="margin:3px 0 0">Owner rankings are live from public records — click "Show N" to list that owner's exact buildings here, then open any one's full history for its recorded deed and debt record.</p></div></div>`;
    els("[data-owner]", body).forEach((b) => b.addEventListener("click", () => openDrill(t, "owner", b.dataset.owner)));
  }

  async function openDrill(t, kind, owner) {
    const title = kind === "sales" ? `Recorded sales in ${t.label} — trailing 12 months` : kind === "owner" ? `${owner} — buildings in ${t.label}` : `Qualifying records in ${t.label}`;
    const veil = openModal(title, spinner("Loading the specific records…"));
    try {
      const qs = new URLSearchParams({ zips: t.zips.join(","), mode: state.mode, kind });
      if (owner) qs.set("owner", owner);
      const d = await api(`/api/area-detail?${qs}`);
      const bodyEl = veil.querySelector(".modal-body");
      if (kind === "sales") {
        bodyEl.innerHTML = `<p class="note">${h(d.coverage)}</p><div class="table-wrap"><table class="tbl">
          <thead><tr><th>Sale date</th><th>Address</th><th class="r">Price</th><th class="r">$/sf</th></tr></thead>
          <tbody>${d.sales.map((s) => `<tr><td>${dateShort(s.saleDate)}</td><td><a href="#/dossier?bbl=${s.bbl}&addr=${encodeURIComponent(s.address)}">${h(s.address)}</a></td><td class="r">${usd(s.salePrice)}</td><td class="r">${usd(s.ppsf)}</td></tr>`).join("") || `<tr><td colspan="4" class="note">No qualifying sales in the window.</td></tr>`}</tbody></table></div>`;
      } else {
        bodyEl.innerHTML = `<p class="note">${h(d.coverage)}</p><div class="table-wrap"><table class="tbl">
          <thead><tr><th>Address</th><th class="r">Resi units</th><th class="r">Year</th><th>Zoning</th><th class="r">Unused sf</th></tr></thead>
          <tbody>${d.buildings.map((b) => `<tr><td><a href="#/dossier?bbl=${b.bbl}&addr=${encodeURIComponent(b.address)}">${h(b.address)}</a><div class="note">BBL ${b.bbl}</div></td><td class="r">${num(b.unitsRes)}</td><td class="r">${b.yearBuilt || "—"}</td><td>${h(b.zoning ?? "—")}</td><td class="r">${b.unusedFarSf ? num(b.unusedFarSf) : "—"}</td></tr>`).join("") || `<tr><td colspan="5" class="note">No matching records.</td></tr>`}</tbody></table></div>`;
      }
    } catch { veil.querySelector(".modal-body").innerHTML = `<p class="note">Could not load records.</p>`; }
  }

  async function renderColdCall(body, t) {
    body.innerHTML = spinner("Building the hooks from live data…");
    let d = null;
    try { d = await api(`/api/territory?zips=${t.zips.join(",")}&mode=${state.mode}`); } catch {}
    const s = d?.sales ?? {};
    const topOwner = d?.ownersByUnits?.[0]?.name;
    const first = t.ppsfHistory?.[0], last = t.ppsfHistory?.[t.ppsfHistory.length - 1];
    const hooks = [];
    hooks.push({ title: `${t.label.toUpperCase()} — MARKET PULSE`, data: `Live: ${s.count ?? "—"} arm's-length sales in ${t.label} over the last 12 months at a median of ${s.medianPpsf != null ? usd(s.medianPpsf) : "—"} ${s.metric ?? "$/sf"}.`, script: `I focus specifically on ${t.label}. Over the last twelve months I've tracked ${s.count ?? "every"} sales in the neighborhood, and the pricing is sitting around ${s.medianPpsf != null ? usd(s.medianPpsf) : "a level"} a foot. I wanted to share where that puts a building like yours. Two minutes?` });
    if (first && last) hooks.push({ title: `${t.label.toUpperCase()} — THE TREND`, data: `${t.label} sale $/sf has moved from roughly $${first.ppsf.toLocaleString()} (${first.year}) to about $${last.ppsf.toLocaleString()} today (researched trend; current figure is live).`, script: `${t.label} has had a remarkable run — values have gone from around $${first.ppsf.toLocaleString()} a foot in ${first.year} to roughly $${last.ppsf.toLocaleString()} today. Most owners I talk to don't realize how far it's moved. I'd love to walk you through what that means for your basis.` });
    if (t.notableStory) hooks.push({ title: `${t.label.toUpperCase()} — THE STORY`, data: t.notableStory, script: `I've been studying ${t.label} closely — even the history. ${t.notableStory.split(".")[0]}. Owners love hearing the story of their own block, and it's a natural way for me to share where values are heading. Do you have a minute?` });
    hooks.push({ title: `${t.label.toUpperCase()} — OWNERSHIP`, data: topOwner ? `Largest owner by units in ${t.label} (live public records): ${topOwner}.` : `I track who owns the most units and buildings in ${t.label}.`, script: `I keep a live map of who owns what in ${t.label} — who holds the most buildings, the most units, who's been buying and selling. It means when something trades, I usually know the players before anyone else. I'd like to be that resource for you.` });
    hooks.push(state.mode === "development"
      ? { title: `${t.label.toUpperCase()} — THE UPZONING`, data: "Underbuilt parcels here sit well below their as-of-right ceiling — exactly the profile developers are paying up for.", script: `There's real development demand in ${t.label} right now, and I track every underbuilt parcel against its zoning. Your site may be worth materially more as land than as its current use — wanted to share the numbers.` }
      : { title: `${t.label.toUpperCase()} — OPERATING PRESSURE`, data: `Tax, insurance, and rate pressure are squeezing free-market NOI across ${t.label}; valuations are repricing.`, script: `Operating costs and rates have changed the math on free-market multifamily in ${t.label}. I've been tracking how that's hitting valuations building-by-building. Worth a couple of minutes to see where yours stands?` });
    const seq = [
      ["W1", "WEEK 1 — Information Call", `Lead with a ${t.label}-specific data point — a comp, a trend, the history of their block. Never ask if they want to sell. Goal: 2+ minutes, confirm email, learn who decides.`],
      ["W2", "WEEK 2 — Comp Call", `"A comp closed nearby — here's the $/unit, and your building is comparable in X way." Send the brief after. Paper trail of value before any ask.`],
      ["W3", "WEEK 3 — Soft Ask", `"When you think about a transaction — not now, but when the time comes — what would that look like? Who's the first call?" Surfaces timing without resistance.`]
    ];
    body.innerHTML = `
      <div class="eyebrow">The Method, Applied · ${h(t.label)}</div>
      <h2 style="font-size:24px;margin:4px 0 6px;letter-spacing:-.02em">${h(t.label)} Cold-Call Hooks</h2>
      <p class="sub" style="max-width:680px;font-style:italic;border-left:3px solid var(--accent);padding-left:12px">Never ask for business. Offer something of value first — and make it specific to ${h(t.label)}. The data is the value; the call is delivery. ${d ? `Live as of ${new Date(d.fetchedAt).toLocaleString()}.` : ""}</p>
      <div style="display:grid;gap:14px;margin-top:18px">
        ${hooks.map((k, i) => `<div class="hook-card"><header><span class="hook-num">${i + 1}</span>${h(k.title)}</header>
          <div style="padding:14px 16px"><div class="hook-data">${h(k.data)}</div><div class="hook-script">${h(k.script)}</div></div></div>`).join("")}
      </div>
      <div class="sect-head"><span class="t">The Three-Call Sequence</span></div>
      <div style="display:grid;gap:14px">
        ${seq.map(([n, title, text]) => `<div class="hook-card"><header><span class="hook-num">${n}</span>${h(title)}</header>
          <div style="padding:14px 16px;font-size:13px;line-height:1.7">${h(text)}</div></div>`).join("")}
      </div>`;
  }

  function renderCadence(body, areaLabel) {
    const days = [
      { name: "Monday", gold: false, items: [`Ownership pull: new ${areaLabel} deeds`, "Permit pull: new permits on target blocks", "Update owner DB with new transfers", "Set the week's call list"] },
      { name: "Tuesday", gold: true, items: [`${areaLabel} calls (10 live connections)`, "Real Deal / Commercial Observer scan", "Log every call in CRM", "Flag engaged owners"] },
      { name: "Wednesday", gold: false, items: ["More area calls (5–8 connections)", "Tax lien list check", "Update prospecting scores", "Prep comp data for W2 follow-ups"] },
      { name: "Thursday", gold: true, items: ["Draft the weekly intelligence brief", "Deep research: area pipeline", "Match new leads to buyer list", "Conflict checks"] },
      { name: "Friday", gold: false, items: ["Publish weekly brief", "Send to distribution list", "Review call log + follow-ups", "What do I know now I didn't Monday?"] }
    ];
    body.innerHTML = `
      <div class="eyebrow">Execution · The Weekly System</div>
      <h2 style="font-size:24px;margin:4px 0 6px;letter-spacing:-.02em">Your Weekly Operating Cadence</h2>
      <p class="sub" style="max-width:680px;font-style:italic;border-left:3px solid var(--accent);padding-left:12px">A real intelligence desk is built by showing up every week and compounding knowledge. This is your operating system.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:11px;margin-top:18px">
        ${days.map((d) => `<div class="card" style="padding:13px 13px;border-top:3px solid ${d.gold ? "var(--amber)" : "var(--rail)"}">
          <p class="eyebrow dim" style="margin:0 0 8px">${h(d.name)}</p>
          <ul style="list-style:none;margin:0;padding:0;display:grid;gap:5px">${d.items.map((i) => `<li style="font-size:12px">→ ${h(i)}</li>`).join("")}</ul>
        </div>`).join("")}
      </div>
      <div class="quote" style="margin-top:22px">The people with twenty and thirty years of experience stopped learning. You build knowledge — and knowledge creates the relationships.
        <span style="display:block;margin-top:10px;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;font-style:normal;color:hsl(203 95% 70%)">— The principle, applied</span></div>`;
  }
  return {};
}
