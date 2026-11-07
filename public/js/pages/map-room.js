// Market Intel — the map room. Curated opportunity markers + NTA hover/click
// areas + the every-lot grid (land use / air rights / ownership lenses) +
// buildings mode with the live inventory list, building detail drawer and
// the curated-parcel dossier drawer.
import { api } from "../api.js";
import { el, els, h, scorePill, categoryBadge, spinner, toast, openDocumentPreview, enhanceHScroll } from "../ui.js";
import { num, sf, exportCsv, exportXls, BUILDING_EXPORT_COLUMNS } from "../lib/format.js";
import {
  NEIGHBORHOODS, CATEGORIES, SIGNALS, SIGNAL_LABELS, CATEGORY_COLORS, scoreColor,
  LAND_USE_BANDS, AIR_BANDS, OWNER_BANDS, OWNER_KIND_LABELS, airRights, airBandOf,
  landUseBandOf, classifyOwner, normalizeOwner, ownerUnavailable, resolveAreaToZips,
  AREA_PRESETS, assetClassOf, ASSET_CLASS_COLORS, ASSET_CLASS_LABELS, LAND_USE_LABELS, SORT_OPTIONS
} from "../lib/constants.js";
import { renderDossierPanel } from "./dossier-panel.js";
import { renderLotDetail } from "./lot-detail.js";
import { renderBuildingDetail } from "./building-detail.js";
import { scoutReportHtml } from "../lib/reports.js";

const NYC_CENTER = [40.718, -73.965];
const NYC_ZOOM = 11;
const LOT_GRID_ZOOM = 15;

const state = {
  minScore: 50, categories: new Set(), neighborhoods: new Set(), signals: new Set(),
  adaptiveOnly: false, search: "", area: "", selectedId: null, selectedBbl: null,
  assetClass: null, page: 0, sort: "score", lastView: null
};

export async function mount(root, { params }) {
  if (params.get("area")) state.area = params.get("area");
  const seeds = await api("/api/opportunities");
  state.selectedId ??= seeds[0]?.id ?? null;

  root.innerHTML = `<div class="split" id="mi-root">
    <div class="scroll" style="border-right:1px solid var(--line);background:var(--bg);padding:12px" id="mi-filters"></div>
    <div style="position:relative;min-height:420px" id="mi-map-wrap">
      <div class="map-shell" id="mi-map"></div>
      <div id="mi-strip" style="position:absolute;left:0;right:0;bottom:0;z-index:500;background:color-mix(in oklab,var(--bg-raised) 93%,transparent);backdrop-filter:blur(8px);border-top:1px solid var(--line)"></div>
      <div class="drawer" id="mi-dossier">
        <div class="drawer-head"><span class="t">Parcel Dossier</span>
          <button class="btn sm ghost" id="mi-refresh">Refresh evidence</button>
          <button class="iconbtn" data-close-dossier>✕</button></div>
        <div class="drawer-body scroll" id="mi-dossier-body"></div>
      </div>
      <div class="drawer" id="mi-lot" style="z-index:1250">
        <div class="drawer-head"><span class="t">Lot Detail</span><button class="iconbtn" data-close-lot>✕</button></div>
        <div class="drawer-body scroll" id="mi-lot-body"></div>
      </div>
      <div class="drawer" id="mi-bldg" style="z-index:1240">
        <div class="drawer-head"><span class="t">Building Detail</span><button class="iconbtn" data-close-bldg>✕</button></div>
        <div class="drawer-body scroll" id="mi-bldg-body"></div>
      </div>
      <div class="hover-card" id="mi-hover" style="display:none"></div>
    </div>
  </div>`;

  const areaInfo = () => resolveAreaToZips(state.area.trim() || state.search.trim());
  const isBuildingsMode = () => areaInfo().zips.length > 0;

  // ------------------------------------------------------------------ Map
  const map = L.map(el("#mi-map"), {
    center: state.lastView?.center ?? NYC_CENTER, zoom: state.lastView?.zoom ?? NYC_ZOOM,
    zoomControl: false, preferCanvas: true,
    rotate: true, rotateControl: { closeOnZeroBearing: false, position: "topright" },
    touchRotate: true, shiftKeyRotate: true, bearing: 0
  });
  L.control.zoom({ position: "topright" }).addTo(map);
  let baseMode = "streets";
  const isDark = () => document.documentElement.dataset.theme === "dark";
  const baseUrl = () => baseMode === "satellite" ? "/api/mbtile/{z}/{x}/{y}" : isDark() ? "/api/mbtile/dark/{z}/{x}/{y}" : map.getZoom() >= LOT_GRID_ZOOM && gridOn ? "/api/mbtile/nolabels/{z}/{x}/{y}" : "/api/mbtile/streets/{z}/{x}/{y}";
  let base = L.tileLayer(baseUrl(), { attribution: "© CARTO © OpenStreetMap © Esri — parcels live from public records", maxZoom: 19 }).addTo(map);
  function refreshBase() {
    const url = baseUrl();
    if (base._url !== url) base.setUrl(url);
  }
  const themeH = () => refreshBase();
  window.addEventListener("themechange", themeH);

  const satBtn = mapButton(map, "topright", "Satellite", () => {
    baseMode = baseMode === "streets" ? "satellite" : "streets";
    satBtn.textContent = baseMode === "satellite" ? "Street map" : "Satellite";
    refreshBase();
  });
  mapButton(map, "topright", "Reset map", () => { map.setBearing?.(0); map.setView(NYC_CENTER, NYC_ZOOM, { animate: true }); });
  let city3d = null;
  const btn3d = mapButton(map, "topright", "3D City", async () => {
    const c = map.getCenter();
    const mod = await import("./city3d.js");
    city3d = mod.openCity3d({ lat: c.lat, lng: c.lng, zoom: map.getZoom() });
  });
  btn3d.title = "This area as the real city in 3D — photorealistic in LAB mode, click any building for its lot";
  btn3d.style.background = "hsl(221 90% 53%)"; btn3d.style.color = "#fff"; btn3d.style.borderColor = "hsl(221 85% 46%)";
  let gridOn = true;
  const gridBtn = mapButton(map, "topright", "Lot grid: on", () => {
    gridOn = !gridOn;
    gridBtn.textContent = gridOn ? "Lot grid: on" : "Lot grid: off";
    refreshBase(); drawLotGrid(); updateKey();
  });

  // NTA chip + overlay
  const ntaChip = mapChip(map, "bottomleft", "Hover an area to see its border · click to load its assets");
  const countChip = mapChip(map, "bottomright", "Zoom in for the lot grid");
  let ntaLayer = null, ntaReq = 0;
  async function drawNtas() {
    if (map.getZoom() < 11) { if (ntaLayer) { map.removeLayer(ntaLayer); ntaLayer = null; } return; }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
    const seq = ++ntaReq;
    try {
      const data = await api(`/api/nta-polys?bbox=${bbox}`);
      if (seq !== ntaReq || !map._loaded) return;
      if (ntaLayer) map.removeLayer(ntaLayer);
      const idle = { color: "#1f54c6", weight: 1, opacity: 0.45, fillColor: "#1f54c6", fillOpacity: 0.04 };
      const hot = { color: "#0b3aa3", weight: 3, opacity: 0.95, fillColor: "#3878ff", fillOpacity: 0.16 };
      const interactive = !(gridOn && map.getZoom() >= LOT_GRID_ZOOM);
      ntaLayer = L.geoJSON({ type: "FeatureCollection", features: data.features.map((f) => ({ type: "Feature", properties: { name: f.name, boro: f.boro }, geometry: f.geom })) }, {
        style: () => ({ ...idle, interactive }),
        onEachFeature: (f, layer) => {
          if (!interactive) return;
          const nm = f.properties.name;
          layer.bindTooltip(nm, { sticky: true, direction: "top", opacity: 1 });
          layer.on("mouseover", () => { layer.setStyle(hot); layer.bringToFront(); ntaChip.innerHTML = `<b>${h(nm)}</b>${f.properties.boro ? ` · ${h(f.properties.boro)}` : ""} — click to load`; });
          layer.on("mouseout", () => { layer.setStyle(idle); ntaChip.innerHTML = "Hover an area to see its border · click to load its assets"; });
          layer.on("click", async (e) => {
            ntaChip.innerHTML = `Loading <b>${h(nm)}</b>…`;
            try {
              const z = await api(`/api/zip-at?lat=${e.latlng.lat}&lng=${e.latlng.lng}`);
              setArea(z.zip || nm);
            } catch { setArea(nm); }
          });
        }
      }).addTo(map);
      ntaLayer.bringToBack();
    } catch { /* offline tiles are fine */ }
  }

  // ------------------------------------------------------------ Lot grid
  const gridLayer = L.layerGroup().addTo(map);
  const tileStore = new Map();
  let gridReq = 0, gridMode = "landuse", ownerFilter = "any", highlightOwner = "";
  const bandsOn = { landuse: new Set(LAND_USE_BANDS.map((b) => b.key)), air: new Set(AIR_BANDS.map((b) => b.key)), owner: new Set(OWNER_BANDS.map((b) => b.key)) };
  const ownerCounts = new Map();
  const bandsFor = (mode) => (mode === "air" ? AIR_BANDS : mode === "owner" ? OWNER_BANDS : LAND_USE_BANDS);
  const bandOf = (p, mode) => (mode === "air" ? airBandOf(p) : mode === "owner" ? classifyOwner(p.owner) : landUseBandOf(p));
  const colorOf = (p, mode) => bandsFor(mode).find((b) => b.key === bandOf(p, mode))?.color ?? "#8A97A6";
  const multiOwner = (p) => !!p.owner && !ownerUnavailable(p.owner) && (ownerCounts.get(normalizeOwner(p.owner)) ?? 0) >= 2;
  const passOwnerFilter = (p) => ownerFilter === "any" ? true : ownerFilter === "individual" ? ["individual", "trust"].includes(classifyOwner(p.owner)) : ["llc", "corp"].includes(classifyOwner(p.owner));

  function lotStyle(p) {
    const hl = !!highlightOwner && normalizeOwner(p.owner) === highlightOwner;
    const multi = multiOwner(p);
    return { color: hl ? "#0E1F33" : multi ? "#4A5568" : "#ffffff", weight: hl ? 2.2 : multi ? 1.4 : 0.5, opacity: hl ? 1 : 0.85, fillColor: colorOf(p, gridMode), fillOpacity: hl ? 0.85 : 0.62 };
  }
  function recountOwners() {
    ownerCounts.clear();
    tileStore.forEach((grp) => (grp._polys ?? []).forEach((ly) => {
      const k = normalizeOwner(ly._p?.owner);
      if (k) ownerCounts.set(k, (ownerCounts.get(k) ?? 0) + 1);
    }));
  }
  function visibleLots() {
    const out = [];
    tileStore.forEach((grp) => grp.getLayers().forEach((ly) => ly._p && out.push(ly._p)));
    return out;
  }
  function updateCountChip() {
    let shown = 0, total = 0;
    tileStore.forEach((grp) => { shown += grp.getLayers().length; total += (grp._polys ?? []).length; });
    if (!total) { countChip.innerHTML = map.getZoom() < LOT_GRID_ZOOM ? `Zoom in for the lot grid <span style="opacity:.7">(z${map.getZoom()}/${LOT_GRID_ZOOM})</span>` : gridOn ? "No lots here" : "Lot grid: off"; return; }
    if (highlightOwner) {
      let name = "", n = 0;
      tileStore.forEach((grp) => grp.getLayers().forEach((ly) => { if (normalizeOwner(ly._p?.owner) === highlightOwner) { name = ly._p.owner; n++; } }));
      if (n) { countChip.innerHTML = `<b>${h(name)}</b> — ${n} lot${n === 1 ? "" : "s"} highlighted in view<span style="opacity:.7"> · open one for the full portfolio</span>`; return; }
    }
    let flagged = 0, unused = 0;
    tileStore.forEach((grp) => grp.getLayers().forEach((ly) => { if (multiOwner(ly._p)) flagged++; unused += airRights(ly._p).unusedBsf ?? 0; }));
    const lots = shown !== total ? `<b>${shown.toLocaleString()}</b> of ${total.toLocaleString()} lots` : `<b>${total.toLocaleString()}</b> lots`;
    countChip.innerHTML = (gridMode === "air" && unused ? `${lots} · <b>${unused.toLocaleString()}</b> unused bsf` : lots) + (flagged ? ` · <b style="color:#B02A5B">⚑ ${flagged.toLocaleString()}</b> owned by a multi-lot owner` : "");
  }
  function refilterGrid() {
    const on = bandsOn[gridMode];
    tileStore.forEach((grp) => (grp._polys ?? []).forEach((ly) => {
      const ok = on.has(bandOf(ly._p, gridMode)) && passOwnerFilter(ly._p);
      const has = grp.hasLayer(ly);
      if (ok && !has) grp.addLayer(ly);
      else if (!ok && has) grp.removeLayer(ly);
    }));
    updateCountChip();
  }
  function restyleGrid() {
    tileStore.forEach((grp) => (grp._polys ?? []).forEach((ly) => ly.setStyle(lotStyle(ly._p))));
    refilterGrid();
  }
  const hoverEl = el("#mi-hover");
  function lotTip(p) {
    const kind = classifyOwner(p.owner);
    const kindLabel = OWNER_KIND_LABELS[kind] ?? "";
    const n = ownerCounts.get(normalizeOwner(p.owner)) ?? 0;
    const a = airRights(p);
    const airLine = a.unusedBsf === null ? "" : a.overbuilt ? `<br/><b style="color:#B9C2CC">Overbuilt</b> — ${p.builtFar} built / ${a.maxFar} max FAR` : a.unusedBsf > 0 ? `<br/><b style="color:#E2565E">+${a.unusedBsf.toLocaleString()} bsf unused</b>${a.encumbered.length ? ` <span style="opacity:.7">(${a.encumbered.length} restriction${a.encumbered.length > 1 ? "s" : ""})</span>` : ""}` : `<br/><span style="opacity:.7">Built out</span>`;
    return `<b>${h(p.address ?? p.bbl)}</b><br/>${h(p.owner ?? "Owner on record")}${p.owner && kind !== "unknown" ? ` <span style="opacity:.7">· ${h(kindLabel)}</span>` : ""}` +
      (n >= 2 ? `<br/><b style="color:#B02A5B">⚑ Owner holds ${n} lots in view</b><span style="opacity:.65"> · click to highlight them</span>` : "") +
      `<br/>Class ${h(p.bldgClass ?? "—")}${p.zoning ? ` · ${h(p.zoning)}` : ""}${p.units ? ` · ${p.units} units` : ""}${p.yearBuilt ? ` · built ${p.yearBuilt}` : ""}${airLine}` +
      `<br/><span style="opacity:.65">Click for detail · double-click for full dossier</span>`;
  }
  async function drawLotGrid() {
    if (!gridOn || map.getZoom() < LOT_GRID_ZOOM) {
      gridLayer.clearLayers(); tileStore.clear(); updateCountChip(); updateKey(); return;
    }
    const seq = ++gridReq;
    const z = Math.min(map.getZoom(), 16);
    const b = map.getBounds();
    const t0 = tileXY(b.getNorth(), b.getWest(), z), t1 = tileXY(b.getSouth(), b.getEast(), z);
    const wanted = [];
    for (let x = t0.x; x <= t1.x; x++) for (let y = t0.y; y <= t1.y; y++) wanted.push(`${z}/${x}/${y}`);
    for (const [k, grp] of [...tileStore.entries()]) if (!wanted.includes(k)) { gridLayer.removeLayer(grp); tileStore.delete(k); }
    const need = wanted.filter((k) => !tileStore.has(k));
    if (!need.length) { recountOwners(); restyleGrid(); return; }
    countChip.innerHTML = "Loading the lot grid…";
    await Promise.all(need.map(async (k) => {
      try {
        const data = await api(`/api/lot-tiles/${k}`);
        if (seq !== gridReq || tileStore.has(k)) return;
        const grp = L.layerGroup();
        const polys = [];
        for (const f of data.features ?? []) {
          if (!f.geometry) continue;
          const p = f.properties ?? {};
          const layer = L.geoJSON(f, { style: () => lotStyle(p) });
          layer.on("mouseover mousemove", (e) => {
            const ev = e.originalEvent;
            if (!ev) return;
            hoverEl.style.display = "block";
            hoverEl.innerHTML = lotTip(p);
            const x = Math.min(Math.max(ev.clientX, 160), window.innerWidth - 160);
            hoverEl.style.left = x - 150 + "px";
            hoverEl.style.top = (ev.clientY > 280 ? ev.clientY - hoverEl.offsetHeight - 14 : ev.clientY + 18) + "px";
          });
          layer.on("mouseout", () => { hoverEl.style.display = "none"; });
          layer.on("click", () => {
            const key = normalizeOwner(p.owner);
            highlightOwner = highlightOwner === key ? "" : key;
            restyleGrid();
            openLotDetail(p);
          });
          layer.on("dblclick", (e) => {
            L.DomEvent.stop(e);
            if (p.bbl) window.location.hash = `#/dossier?bbl=${p.bbl}&addr=${encodeURIComponent(p.address ?? "")}`;
          });
          layer._p = p;
          polys.push(layer);
          if (bandsOn[gridMode].has(bandOf(p, gridMode)) && passOwnerFilter(p)) grp.addLayer(layer);
        }
        grp._polys = polys;
        tileStore.set(k, grp);
        grp.addTo(gridLayer);
      } catch { /* tile fetch failed */ }
    }));
    if (seq === gridReq) { recountOwners(); restyleGrid(); }
  }

  // Lot-grid key (legend + modes + tools)
  const keyEl = mapChip(map, "topright", "", "lot-key");
  let keyOpen = window.innerWidth >= 900;
  function updateKey() {
    const active = gridOn && map.getZoom() >= LOT_GRID_ZOOM;
    keyEl.style.display = active ? "block" : "none";
    if (!active) return;
    const bands = bandsFor(gridMode);
    const on = bandsOn[gridMode];
    const title = gridMode === "air" ? "Air rights" : gridMode === "owner" ? "Ownership" : "Land use";
    keyEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <button data-key-toggle style="font-weight:800;font-size:11px">${title} <span style="opacity:.6">${keyOpen ? "▾" : "▸"}</span></button>
        ${keyOpen ? `<button data-key-all class="btn sm" style="padding:1px 7px">${on.size === bands.length ? "None" : "All"}</button>` : ""}
      </div>
      ${keyOpen ? `
      <div style="display:flex;gap:4px;margin:7px 0">
        ${["landuse", "air", "owner"].map((m) => `<button data-key-mode="${m}" class="chip ${gridMode === m ? "on" : ""}" style="padding:2px 9px;font-size:10px">${m === "landuse" ? "Land use" : m === "air" ? "Air rights" : "Owner"}</button>`).join("")}
      </div>
      <div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint);margin:4px 0 3px">Owned by</div>
      <div style="display:flex;gap:4px;margin-bottom:6px">
        ${[["any", "Any owner"], ["individual", "Individual"], ["entity", "LLC / entity"]].map(([k, l]) => `<button data-key-of="${k}" class="chip ${ownerFilter === k ? "on" : ""}" style="padding:2px 8px;font-size:10px">${l}</button>`).join("")}
      </div>
      <div class="lot-key-body scroll">
        ${bands.map((b) => `<button class="lot-key-row ${on.has(b.key) ? "" : "off"}" data-key-band="${b.key}"><i style="background:${on.has(b.key) ? b.color : "transparent"};border-color:${b.color}"></i><span>${h(b.label)}</span></button>`).join("")}
      </div>
      ${gridMode === "air" ? `<p class="note" style="margin:6px 0 0">Unused buildable = max FAR × lot area − built area. Unused is not the same as transferable — restrictions are flagged on each lot.</p>` : ""}
      ${gridMode === "owner" ? `<p class="note" style="margin:6px 0 0">Read from the owner name on the roll — a signal, not a legal determination.</p>` : ""}
      <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
        <button class="btn sm" data-key-tool="csv">⬇ CSV</button>
        <button class="btn sm" data-key-tool="scout">Scout report</button>
        <span class="badge" style="color:var(--amber);border-color:currentColor">BETA</span>
      </div>` : ""}`;
    keyEl.querySelector("[data-key-toggle]")?.addEventListener("click", () => { keyOpen = !keyOpen; updateKey(); });
    keyEl.querySelector("[data-key-all]")?.addEventListener("click", () => {
      if (on.size === bands.length) on.clear(); else bands.forEach((b) => on.add(b.key));
      updateKey(); refilterGrid();
    });
    els("[data-key-mode]", keyEl).forEach((b) => b.addEventListener("click", () => { gridMode = b.dataset.keyMode; updateKey(); restyleGrid(); }));
    els("[data-key-of]", keyEl).forEach((b) => b.addEventListener("click", () => { ownerFilter = b.dataset.keyOf; updateKey(); refilterGrid(); }));
    els("[data-key-band]", keyEl).forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.keyBand;
      on.has(k) ? on.delete(k) : on.add(k);
      updateKey(); refilterGrid();
    }));
    els("[data-key-tool]", keyEl).forEach((b) => b.addEventListener("click", () => (b.dataset.keyTool === "csv" ? exportGridCsv() : scoutReport())));
  }
  function exportGridCsv() {
    const lots = visibleLots();
    if (!lots.length) return toast("No lots in view.");
    exportCsv(`lot-grid-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`, [
      { header: "bbl", value: (l) => l.bbl }, { header: "address", value: (l) => l.address },
      { header: "owner", value: (l) => l.owner }, { header: "owner_type", value: (l) => OWNER_KIND_LABELS[classifyOwner(l.owner)] },
      { header: "land_use", value: (l) => LAND_USE_LABELS[l.landUse] ?? l.landUse ?? "" },
      { header: "zoning", value: (l) => l.zoning }, { header: "units", value: (l) => l.units },
      { header: "lot_sf", value: (l) => l.lotArea }, { header: "bldg_sf", value: (l) => l.bldgArea },
      { header: "built_far", value: (l) => l.builtFar }, { header: "max_far", value: (l) => airRights(l).maxFar || "" },
      { header: "unused_bsf", value: (l) => airRights(l).unusedBsf ?? "" },
      { header: "restrictions", value: (l) => airRights(l).encumbered.join("; ") },
      { header: "assessed_total", value: (l) => l.assessedTotal ?? "" }, { header: "year_built", value: (l) => l.yearBuilt ?? "" }
    ], lots);
  }
  function scoutReport() {
    const lots = visibleLots();
    if (!lots.length) return toast("No lots in view.");
    const bands = bandsFor(gridMode);
    const mixMap = new Map();
    lots.forEach((l) => { const k = bandOf(l, gridMode); mixMap.set(k, (mixMap.get(k) ?? 0) + 1); });
    const mix = bands.map((b) => ({ label: b.label, color: b.color, n: mixMap.get(b.key) ?? 0 })).filter((r) => r.n > 0);
    const holders = new Map();
    lots.forEach((l) => { const k = normalizeOwner(l.owner); if (!k) return; const cur = holders.get(k) ?? { name: l.owner, kind: OWNER_KIND_LABELS[classifyOwner(l.owner)], n: 0 }; cur.n++; holders.set(k, cur); });
    const topHolders = [...holders.values()].filter((o) => o.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10);
    const topUnused = lots.map((l) => ({ ...l, unusedBsf: airRights(l).unusedBsf ?? 0, enc: airRights(l).encumbered.length })).filter((l) => l.unusedBsf > 0).sort((a, b) => b.unusedBsf - a.unusedBsf).slice(0, 10);
    const modeLabel = `${gridMode === "air" ? "Air rights" : gridMode === "owner" ? "Ownership" : "Land use"} view` + (ownerFilter !== "any" ? ` · owned by ${ownerFilter === "individual" ? "individuals/estates" : "LLCs/entities"}` : "");
    openDocumentPreview("Scout Report — Lot Grid", scoutReportHtml({ modeLabel, lots: lots.map((l) => ({ ...l, ownerKind: classifyOwner(l.owner), unusedBsf: airRights(l).unusedBsf ?? 0 })), mix, holders: topHolders, topUnused }));
  }

  // ------------------------------------------------------- Curated markers
  const markerLayer = L.layerGroup().addTo(map);
  let liveOpps = [];
  function filteredOpps() {
    const all = [...seeds, ...liveOpps];
    const seen = new Set();
    return all.filter((p) => {
      if (p.bbl && seen.has(p.bbl)) return false;
      if (p.bbl) seen.add(p.bbl);
      if (p.opportunityScore < state.minScore) return false;
      if (state.categories.size && !state.categories.has(p.category)) return false;
      if (state.neighborhoods.size && !state.neighborhoods.has(p.neighborhood)) return false;
      if (state.signals.size && !p.signals.some((s) => state.signals.has(s))) return false;
      if (state.adaptiveOnly && !p.adaptiveReuse) return false;
      if (state.search) {
        const q = state.search.toLowerCase();
        if (!`${p.address} ${p.neighborhood} ${p.category} ${p.zoning} ${p.bbl} ${p.id}`.toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort((a, b) => b.opportunityScore - a.opportunityScore);
  }
  function drawMarkers() {
    markerLayer.clearLayers();
    filteredOpps().forEach((p, i) => {
      const sel = p.id === state.selectedId;
      const size = sel ? 30 : 15;
      const icon = L.divIcon({ className: "", html: `<div class="map-marker ${sel ? "selected" : ""}" style="width:${size}px;height:${size}px;background:${CATEGORY_COLORS[p.category]};border:${sel ? `2px solid ${scoreColor(p.opportunityScore)}` : "1.5px solid rgba(255,255,255,0.95)"}"><span>${p.opportunityScore}</span></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
      L.marker([p.lat, p.lng], { icon, riseOnHover: true })
        .bindTooltip(`<b>${h(p.address)}</b><br/>${h(p.category)} · ${h(p.neighborhood)}`, { direction: "top", offset: [0, -size / 2], opacity: 0.95 })
        .on("click", () => selectOpp(p.id))
        .addTo(markerLayer);
    });
  }

  // ---------------------------------------------------------- Buildings mode
  const bldgLayer = L.layerGroup().addTo(map);
  let bldgData = null, bldgFetchSeq = 0;
  async function fetchBuildings() {
    const info = areaInfo();
    if (!info.zips.length) { bldgData = null; bldgLayer.clearLayers(); renderStrip(); return; }
    const seq = ++bldgFetchSeq;
    renderStrip(true);
    try {
      const qs = new URLSearchParams({ zips: info.zips.join(","), page: String(state.page), pageSize: "200", sort: state.sort });
      if (state.assetClass) qs.set("class", state.assetClass);
      const data = await api(`/api/area-buildings?${qs}`);
      if (seq !== bldgFetchSeq) return;
      bldgData = data;
      state.selectedBbl ??= data.buildings[0]?.bbl ?? null;
      drawBuildingDots();
      renderStrip();
    } catch (e) { if (seq === bldgFetchSeq) { renderStrip(); toast("Could not load buildings: " + e.message); } }
  }
  function drawBuildingDots() {
    bldgLayer.clearLayers();
    if (!bldgData) return;
    const pts = [];
    for (const b of bldgData.buildings) {
      if (b.lat == null) continue;
      const cls = assetClassOf(b.bldgClass);
      const selected = b.bbl === state.selectedBbl;
      L.circleMarker([b.lat, b.lng], { radius: selected ? 9 : 5, color: selected ? "#0f172a" : ASSET_CLASS_COLORS[cls], weight: selected ? 2 : 1, fillColor: ASSET_CLASS_COLORS[cls], fillOpacity: 0.85 })
        .bindTooltip(`<b>${h(b.address)}</b><br/>${ASSET_CLASS_LABELS[cls]} · score ${b.score}`, { direction: "top", opacity: 0.95 })
        .on("click", () => { state.selectedBbl = b.bbl; drawBuildingDots(); openBuildingDetail(b); })
        .addTo(bldgLayer);
      pts.push([b.lat, b.lng]);
    }
    if (pts.length && !map.getBounds().contains(L.latLngBounds(pts))) map.fitBounds(L.latLngBounds(pts).pad(0.12));
  }

  // ---------------------------------------------------------------- Drawers
  const dossierDrawer = el("#mi-dossier"), lotDrawer = el("#mi-lot"), bldgDrawer = el("#mi-bldg");
  el("[data-close-dossier]").addEventListener("click", () => dossierDrawer.classList.remove("open"));
  el("[data-close-lot]").addEventListener("click", () => { lotDrawer.classList.remove("open"); highlightOwner = ""; restyleGrid(); });
  el("[data-close-bldg]").addEventListener("click", () => bldgDrawer.classList.remove("open"));
  el("#mi-refresh").addEventListener("click", () => {
    const p = [...seeds, ...liveOpps].find((x) => x.id === state.selectedId);
    if (p) renderDossierPanel(el("#mi-dossier-body"), p, { fresh: true });
  });
  function selectOpp(id, openDrawer = true) {
    state.selectedId = id;
    drawMarkers(); renderStrip();
    const p = [...seeds, ...liveOpps].find((x) => x.id === id);
    if (p && openDrawer) {
      dossierDrawer.classList.add("open");
      renderDossierPanel(el("#mi-dossier-body"), p);
      map.panTo([p.lat, p.lng], { animate: true });
    }
  }
  function openLotDetail(p) {
    lotDrawer.classList.add("open");
    renderLotDetail(el("#mi-lot-body"), p, { ownerCountInView: ownerCounts.get(normalizeOwner(p.owner)) ?? 0 });
  }
  function openBuildingDetail(b) {
    bldgDrawer.classList.add("open");
    renderBuildingDetail(el("#mi-bldg-body"), b);
  }

  // -------------------------------------------------------------- Filters UI
  function setArea(v) { state.area = v; state.page = 0; state.selectedBbl = null; renderFilters(); onModeChange(); }
  function renderFilters() {
    const info = areaInfo();
    const buildings = info.zips.length > 0;
    el("#mi-filters").innerHTML = `
      <div class="sect-head" style="margin-top:0"><span class="t">Area / Location</span></div>
      <div style="position:relative;margin:8px 0 6px">
        <input id="f-area" class="field" placeholder="Address, ZIP(s), or borough — e.g. 151 W 25 St, 11211, Brooklyn" value="${h(state.area)}" />
        ${state.area ? `<button id="f-area-x" style="position:absolute;right:9px;top:50%;transform:translateY(-50%);color:var(--ink-faint)">✕</button>` : ""}
      </div>
      ${buildings
        ? `<p class="note" style="color:var(--accent-ink)">Every-building mode — <b>${h(info.label)}</b> (${info.zips.length} ZIP${info.zips.length === 1 ? "" : "s"}): every tax lot with full parcel detail, a modeled dev score, and live evidence on click. Asset/score filters below apply to the curated opportunity universe only.</p>`
        : `<p class="note" style="margin:2px 0 4px">Pick an area to explore, then drill in:</p>
           <div style="display:flex;flex-wrap:wrap;gap:5px;margin:0 0 2px">${AREA_PRESETS.slice(0, 3).map((p) => `<button class="chip" data-area-chip="${h(p.label)}" style="padding:3px 10px;font-size:10.5px">${h(p.label)} ›</button>`).join("")}</div>
           <p class="note" style="margin:7px 0 4px">Or drill to a sub-area:</p>
           <div style="display:flex;flex-wrap:wrap;gap:5px;margin:0 0 2px">${AREA_PRESETS.slice(3).map((p) => `<button class="chip" data-area-chip="${h(p.label)}" style="padding:3px 10px;font-size:10.5px">${h(p.label)} ›</button>`).join("")}</div>`}
      ${buildings ? `
        <div class="sect-head"><span class="t">Asset class (live map)</span></div>
        <p class="note" style="margin:0 0 5px">Hunting a specific product type? Set it first:</p>
        <div style="display:flex;flex-wrap:wrap;gap:5px">
          ${[["", "All"], ...Object.entries(ASSET_CLASS_LABELS)].map(([k, l]) => `<button class="chip ${state.assetClass === (k || null) || (!state.assetClass && !k) ? "on" : ""}" data-class-chip="${k}" style="padding:3px 10px;font-size:10.5px">${l}</button>`).join("")}
        </div>
        <p class="note" style="margin-top:6px">Map dots are color-coded by asset class. Pick one to plot only that product type across the area.</p>` : ""}
      <div class="sect-head"><span class="t">Curated universe</span></div>
      <input id="f-search" class="field" placeholder="Search address, BBL, zoning…" value="${h(state.search)}" style="margin-bottom:10px" />
      <label class="lab">Opportunity Score ≥ <b id="f-score-val">${state.minScore}</b>
        <input id="f-score" type="range" min="0" max="100" step="1" value="${state.minScore}" />
      </label>
      <div class="sect-head"><span class="t">Asset Category</span></div>
      <div style="display:grid;gap:4px">${CATEGORIES.map((c) => filterCheck("cat", c, state.categories.has(c), CATEGORY_COLORS[c])).join("")}</div>
      <div class="sect-head"><span class="t">Neighborhood</span></div>
      <div style="display:grid;gap:4px;max-height:200px;overflow-y:auto" class="scroll">${NEIGHBORHOODS.map((n) => filterCheck("hood", n, state.neighborhoods.has(n))).join("")}</div>
      <div class="sect-head"><span class="t">Signal type</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:5px">${SIGNALS.map((s) => `<button class="chip ${state.signals.has(s) ? "on" : ""}" data-signal="${s}" style="font-size:10.5px;padding:3px 10px">${h(SIGNAL_LABELS[s])}</button>`).join("")}</div>
      <div class="card card-pad" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;padding:10px 12px">
        <div><div style="font-size:12px;font-weight:650">Adaptive Reuse / 467-m layer</div><div class="note">Office-to-resi & conversion candidates</div></div>
        <input type="checkbox" id="f-adaptive" ${state.adaptiveOnly ? "checked" : ""} style="width:18px;height:18px;accent-color:var(--accent)" />
      </div>
      <button class="btn sm" id="f-reset" style="margin-top:10px">Reset all filters</button>`;

    el("#f-area").addEventListener("change", (e) => setArea(e.target.value.trim()));
    el("#f-area").addEventListener("keydown", (e) => { if (e.key === "Enter") setArea(e.target.value.trim()); });
    el("#f-area-x")?.addEventListener("click", () => setArea(""));
    els("[data-area-chip]").forEach((b) => b.addEventListener("click", () => setArea(b.dataset.areaChip)));
    els("[data-class-chip]").forEach((b) => b.addEventListener("click", () => { state.assetClass = b.dataset.classChip || null; state.page = 0; renderFilters(); fetchBuildings(); }));
    el("#f-search").addEventListener("input", (e) => { state.search = e.target.value; drawMarkers(); renderStrip(); });
    el("#f-score").addEventListener("input", (e) => { state.minScore = +e.target.value; el("#f-score-val").textContent = state.minScore; drawMarkers(); renderStrip(); });
    els("[data-cat]").forEach((c) => c.addEventListener("change", () => { toggleSet(state.categories, c.dataset.cat); drawMarkers(); renderStrip(); }));
    els("[data-hood]").forEach((c) => c.addEventListener("change", () => { toggleSet(state.neighborhoods, c.dataset.hood); drawMarkers(); renderStrip(); }));
    els("[data-signal]").forEach((b) => b.addEventListener("click", () => { toggleSet(state.signals, b.dataset.signal); renderFilters(); drawMarkers(); renderStrip(); }));
    el("#f-adaptive").addEventListener("change", (e) => { state.adaptiveOnly = e.target.checked; drawMarkers(); renderStrip(); });
    el("#f-reset").addEventListener("click", () => {
      Object.assign(state, { minScore: 50, search: "", area: "", adaptiveOnly: false, assetClass: null, page: 0 });
      state.categories.clear(); state.neighborhoods.clear(); state.signals.clear();
      renderFilters(); onModeChange();
    });
  }
  const filterCheck = (kind, label, checked, color) =>
    `<label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer">
      <input type="checkbox" data-${kind}="${h(label)}" ${checked ? "checked" : ""} style="accent-color:${color ?? "var(--accent)"}" />
      ${color ? `<span style="width:9px;height:9px;border-radius:3px;background:${color};flex:none"></span>` : ""}<span>${h(label)}</span>
    </label>`;
  const toggleSet = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));

  // ------------------------------------------------------------ Bottom strip
  function syncStripHeight() {
    const stripEl = el("#mi-strip");
    if (stripEl) el("#mi-map").style.setProperty("--strip-h", `${stripEl.offsetHeight + 6}px`);
  }
  function renderStrip(loading = false) {
    const strip = el("#mi-strip");
    if (isBuildingsMode()) {
      const info = areaInfo();
      const total = bldgData?.total ?? 0;
      const pages = Math.max(1, Math.ceil(total / 200));
      strip.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--line-soft);flex-wrap:wrap">
          <button class="btn sm" id="s-exit" title="Exit this area — back to the full map">‹ Map</button>
          <span style="font-size:11px"><span style="font-weight:700">Every tax lot</span> in ${h(info.label)} · dot color = asset class</span>
          <span class="note">${loading ? "loading…" : `${num(total)} lots`}</span>
          <span class="spacer" style="flex:1"></span>
          <span class="note">Pull out data →</span>
          <select id="s-sort" class="field" style="width:auto;padding:4px 8px;font-size:11px">${SORT_OPTIONS.map((o) => `<option value="${o.value}" ${state.sort === o.value ? "selected" : ""}>Sort: ${o.label}</option>`).join("")}</select>
          <button class="btn sm" id="s-prev" ${state.page <= 0 ? "disabled" : ""}>‹</button>
          <span class="note tabular">${state.page + 1} / ${pages}</span>
          <button class="btn sm" id="s-next" ${state.page >= pages - 1 ? "disabled" : ""}>›</button>
          <button class="btn sm" id="s-csv">Export</button><button class="btn sm" id="s-xls">Excel</button><button class="btn sm" id="s-all">Export all</button>
        </div>
        <div style="display:flex;gap:8px;overflow-x:auto;padding:9px 12px" id="s-cards">
          ${loading ? spinner("Loading every building…") : (bldgData?.buildings ?? []).slice(0, 60).map((b) => bldgCard(b)).join("") || `<span class="note">No tax lots found.</span>`}
        </div>`;
      enhanceHScroll(el("#s-cards", strip));
      syncStripHeight();
      el("#s-exit").addEventListener("click", () => setArea(""));
      el("#s-sort")?.addEventListener("change", (e) => { state.sort = e.target.value; state.page = 0; fetchBuildings(); });
      el("#s-prev")?.addEventListener("click", () => { state.page = Math.max(0, state.page - 1); fetchBuildings(); });
      el("#s-next")?.addEventListener("click", () => { state.page += 1; fetchBuildings(); });
      el("#s-csv")?.addEventListener("click", () => bldgData && exportCsv(`buildings_${info.label.replace(/[^a-z0-9]+/gi, "-")}`, BUILDING_EXPORT_COLUMNS, bldgData.buildings));
      el("#s-xls")?.addEventListener("click", () => bldgData && exportXls(`buildings_${info.label.replace(/[^a-z0-9]+/gi, "-")}`, BUILDING_EXPORT_COLUMNS, bldgData.buildings));
      el("#s-all")?.addEventListener("click", async (e) => {
        if (!bldgData) return;
        e.target.disabled = true; e.target.textContent = "Pulling…";
        try {
          const all = [];
          const pageCount = Math.max(1, Math.ceil((bldgData.total ?? 0) / 200));
          for (let pg = 0; pg < pageCount; pg++) {
            const r = await api(`/api/area-buildings?zips=${info.zips.join(",")}&sort=${state.sort}${state.assetClass ? `&class=${state.assetClass}` : ""}&page=${pg}`);
            all.push(...(r.buildings ?? []));
          }
          exportCsv(`buildings_${info.label.replace(/[^a-z0-9]+/gi, "-")}_all`, BUILDING_EXPORT_COLUMNS, all);
        } catch { toast("Export failed — try again."); }
        e.target.disabled = false; e.target.textContent = "Export all";
      });
      els("[data-bbl-card]", strip).forEach((c) => c.addEventListener("click", () => {
        const b = bldgData.buildings.find((x) => x.bbl === c.dataset.bblCard);
        if (b) { state.selectedBbl = b.bbl; drawBuildingDots(); openBuildingDetail(b); }
      }));
      const legend = `<div style="position:absolute;left:12px;bottom:${strip.offsetHeight + 10}px"></div>`;
      return legend;
    }
    const list = filteredOpps();
    strip.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--line-soft)">
        <span style="font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)">Opportunities <b style="color:var(--accent-ink)">${list.length}</b></span>
        <span class="note">Click a card to open its dossier →</span>
      </div>
      <div style="display:flex;gap:8px;overflow-x:auto;padding:9px 12px" id="opp-cards">
        ${list.length ? list.map((p) => oppCard(p)).join("") : `<span class="note" style="padding:6px">No sites match the current filters${state.area ? ` — live public records still pull per parcel in each dossier` : ""}.</span>`}
      </div>`;
    enhanceHScroll(el("#opp-cards", strip));
    syncStripHeight();
    els("[data-opp-card]", strip).forEach((c) => c.addEventListener("click", () => selectOpp(c.dataset.oppCard)));
  }
  const oppCard = (p) => `
    <button data-opp-card="${p.id}" class="card" style="width:232px;flex:none;text-align:left;padding:10px 11px;${p.id === state.selectedId ? "border-color:var(--accent-line);background:var(--accent-soft)" : ""}">
      <div style="display:flex;gap:9px;align-items:flex-start">${scorePill(p.opportunityScore, 32)}
        <div style="min-width:0"><div style="font-size:12px;font-weight:650;line-height:1.25">${h(p.address)}</div>
        <div class="note" style="margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h(p.neighborhood)}</div></div></div>
      <div style="margin-top:7px">${categoryBadge(p.category, true)}</div>
    </button>`;
  const bldgCard = (b) => {
    const cls = assetClassOf(b.bldgClass);
    return `<button data-bbl-card="${b.bbl}" class="card" style="width:250px;flex:none;text-align:left;padding:10px 11px;${b.bbl === state.selectedBbl ? "border-color:var(--accent-line);background:var(--accent-soft)" : ""}">
      <div style="display:flex;gap:9px">${scorePill(b.score, 30)}
        <div style="min-width:0"><div style="font-size:12px;font-weight:650;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h(b.address)}</div>
        <div class="note" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ASSET_CLASS_LABELS[cls]} · ${h(b.bldgClass ?? "—")} · BBL ${b.bbl}</div></div></div>
      <div class="note" style="display:flex;gap:9px;margin-top:6px;flex-wrap:wrap">
        <span>Lot ${num(b.lotArea)} sf</span><span>FAR ${b.builtFar ?? "—"}/${b.maxFar ?? "—"}</span>
        ${b.unusedFarSf > 0 ? `<span style="color:var(--accent-ink);font-weight:650">+${num(b.unusedFarSf)} bsf</span>` : ""}
      </div>
      ${b.propensity >= 18 ? `<div style="margin-top:5px"><span class="badge" style="background:${b.propensity >= 55 ? "var(--red-soft)" : "var(--amber-soft)"};color:${b.propensity >= 55 ? "var(--red)" : "var(--amber)"};border-color:currentColor">⚡ Sell-propensity ${b.propensity}</span></div>` : ""}
    </button>`;
  };

  function onModeChange() {
    const buildings = isBuildingsMode();
    markerLayer.clearLayers(); bldgLayer.clearLayers();
    if (buildings) fetchBuildings();
    else { bldgData = null; drawMarkers(); renderStrip(); }
  }

  // Wire map events + first render
  map.on("moveend", () => { state.lastView = { center: map.getCenter(), zoom: map.getZoom() }; drawNtas(); scheduleGrid(); });
  map.on("zoomend", () => { refreshBase(); updateKey(); });
  let gridTimer = null;
  const scheduleGrid = () => { clearTimeout(gridTimer); gridTimer = setTimeout(drawLotGrid, 220); };
  renderFilters();
  drawNtas(); updateKey(); onModeChange(); scheduleGrid();
  [120, 420, 900].forEach((ms) => setTimeout(() => map.invalidateSize(), ms));
  const ro = new ResizeObserver(() => requestAnimationFrame(() => map.invalidateSize()));
  ro.observe(el("#mi-map-wrap"));

  if (state.selectedId && params.get("open") === "dossier") selectOpp(state.selectedId);

  return { destroy() { city3d?.close?.(); ro.disconnect(); window.removeEventListener("themechange", themeH); map.remove(); } };
}

function tileXY(lat, lng, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}
function mapButton(map, position, label, onClick) {
  const Btn = L.Control.extend({ options: { position }, onAdd() {
    const b = L.DomUtil.create("button", "leaflet-bar mapbtn");
    b.type = "button"; b.textContent = label;
    L.DomEvent.disableClickPropagation(b);
    L.DomEvent.on(b, "click", onClick);
    this._el = b;
    return b;
  } });
  const c = new Btn().addTo(map);
  return c._el;
}
function mapChip(map, position, html, extraClass = "") {
  const Chip = L.Control.extend({ options: { position }, onAdd() {
    const d = L.DomUtil.create("div", "map-chip " + extraClass);
    d.innerHTML = html;
    L.DomEvent.disableClickPropagation(d);
    L.DomEvent.disableScrollPropagation(d);
    return d;
  } });
  const c = new Chip().addTo(map);
  return c.getContainer();
}
