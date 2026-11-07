// 3D City — the map room's third dimension. Two engines:
//  · "3D" (BETA): vendored MapLibre GL — lot pads + extruded massing from the
//    same tile endpoints as the 2D grid, on sat / day / night basemaps.
//  · "Photorealistic" (LAB): Google Photorealistic 3D Tiles via CesiumJS,
//    gated behind /api/3d-session (GOOGLE_3D_KEY) with a daily session cap.
import { el, els, h } from "../ui.js";
import { LAND_USE_BANDS } from "../lib/constants.js";

const CESIUM_BASE = "https://cesium.com/downloads/cesiumjs/releases/1.119/Build/Cesium";

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  return new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-maplibre]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = "/vendor/maplibre/maplibre-gl.css"; link.dataset.maplibre = "1";
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = "/vendor/maplibre/maplibre-gl.js";
    s.onload = () => resolve(window.maplibregl);
    s.onerror = () => reject(new Error("MapLibre failed to load"));
    document.head.appendChild(s);
  });
}

function loadCesium() {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  return new Promise((resolve, reject) => {
    if (!document.querySelector("link[data-cesium]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = `${CESIUM_BASE}/Widgets/widgets.css`; link.dataset.cesium = "1";
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = `${CESIUM_BASE}/Cesium.js`;
    s.onload = () => resolve(window.Cesium);
    s.onerror = () => reject(new Error("Cesium failed to load"));
    document.head.appendChild(s);
  });
}

function styleFor(mode) {
  const style = {
    version: 8,
    sources: {
      base: {
        type: "raster", tileSize: 256,
        tiles: [mode === "sat" ? "/api/mbtile/{z}/{x}/{y}" : mode === "night" ? "/api/mbtile/dark/{z}/{x}/{y}" : "/api/mbtile/nolabels/{z}/{x}/{y}"]
      }
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": mode === "night" ? "#0b0e14" : "#dfe6ee" } },
      { id: "base", type: "raster", source: "base" }
    ]
  };
  if (mode === "day") {
    style.sources.labels = { type: "raster", tileSize: 256, tiles: ["/api/mbtile/labels/{z}/{x}/{y}"] };
  }
  return style;
}

const lngLatToTile = (lat, lng, z) => {
  const n = Math.pow(2, z);
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
};

const luColorExpr = (prop) => {
  const m = ["match", ["coalesce", ["get", prop], "ZZ"]];
  for (const b of LAND_USE_BANDS) { m.push(b.key, b.color); }
  m.push("#8A97A6");
  return m;
};

export function openCity3d({ lat, lng, zoom = 15 }) {
  const root = document.createElement("div");
  root.id = "c3d";
  root.innerHTML = `
    <div class="c3d-bar">
      <b>3D City</b>
      <span class="pill-toggle" id="c3d-engine">
        <button class="on" data-eng="ml">3D <sup>BETA</sup></button>
        <button data-eng="ph">Photorealistic <sup>LAB</sup></button>
      </span>
      <span class="pill-toggle" id="c3d-base">
        <button class="on" data-b="sat">Sat</button><button data-b="day">Day</button><button data-b="night">Night</button>
      </span>
      <span style="color:rgba(255,255,255,.55);font-size:10.5px">Drag = move · right-drag or ⇧-drag = rotate &amp; tilt · scroll = zoom · click a building for its lot</span>
      <span style="flex:1"></span>
      <button class="btn sm" id="c3d-close">Back to the 2D map (or press Esc)</button>
    </div>
    <div class="c3d-stage" id="c3d-ml"></div>
    <div class="c3d-stage" id="c3d-ph" style="display:none"></div>
    <div class="c3d-legend" id="c3d-legend"></div>
    <div class="c3d-status" id="c3d-status">Loading the city…</div>
    <div class="c3d-gate" id="c3d-gate" style="display:none"></div>`;
  document.body.appendChild(root);
  document.body.style.overflow = "hidden";

  let mlMap = null, cesiumViewer = null, closed = false;
  let baseMode = "sat";
  const excluded = new Set();
  const status = (t) => { const n = el("#c3d-status"); if (n) { n.textContent = t || ""; n.style.display = t ? "" : "none"; } };

  function close() {
    if (closed) return;
    closed = true;
    try { mlMap?.remove(); } catch { /* engine may not have finished booting */ }
    try { cesiumViewer?.destroy(); } catch { /* same */ }
    window.removeEventListener("keydown", onKey);
    document.body.style.overflow = "";
    root.remove();
  }
  const onKey = (e) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey);
  el("#c3d-close").addEventListener("click", close);

  // ---------------------------------------------------------------- legend
  function renderLegend() {
    el("#c3d-legend").innerHTML = `
      <div class="eyebrow" style="margin-bottom:5px">Land use — tap to hide</div>
      ${LAND_USE_BANDS.map((b) => `
        <button class="c3d-key ${excluded.has(b.key) ? "off" : ""}" data-lu="${b.key}">
          <span class="dot" style="background:${b.color}"></span>${h(b.label)}
        </button>`).join("")}
      ${excluded.size ? `<button class="c3d-key" data-lu-all style="text-decoration:underline;font-weight:650">Show all</button>` : ""}`;
    els("[data-lu]").forEach((btn) => btn.addEventListener("click", () => {
      const k = btn.dataset.lu;
      excluded.has(k) ? excluded.delete(k) : excluded.add(k);
      applyFilters(); renderLegend();
    }));
    el("[data-lu-all]")?.addEventListener("click", () => { excluded.clear(); applyFilters(); renderLegend(); });
  }
  function applyFilters() {
    if (!mlMap) return;
    const list = Array.from(excluded);
    const filt = (prop) => (list.length ? ["match", ["coalesce", ["get", prop], "ZZ"], list, false, true] : null);
    try { mlMap.getLayer("lots-pads") && mlMap.setFilter("lots-pads", filt("landUse")); } catch { /* style may be mid-swap */ }
    try { mlMap.getLayer("bldgs-3d") && mlMap.setFilter("bldgs-3d", filt("lu")); } catch { /* same */ }
  }

  // ------------------------------------------------------------- MapLibre
  const tileCache = new Map();
  async function fetchCity(mapInst) {
    const b = mapInst.getBounds();
    const z = 16;
    const tl = lngLatToTile(b.getNorth(), b.getWest(), z);
    const br = lngLatToTile(b.getSouth(), b.getEast(), z);
    const jobs = [];
    let count = 0;
    for (let x = tl.x; x <= br.x; x++) for (let y = tl.y; y <= br.y; y++) {
      if (++count > 16) break;
      const key = `${z}/${x}/${y}`;
      if (!tileCache.has(key)) {
        tileCache.set(key, Promise.all([
          fetch(`/api/lot-tiles/${key}`).then((r) => r.json()).catch(() => ({ features: [] })),
          fetch(`/api/bldg-tiles/${key}`).then((r) => r.json()).catch(() => ({ features: [] }))
        ]));
      }
      jobs.push(tileCache.get(key));
    }
    const parts = await Promise.all(jobs);
    return {
      lots: { type: "FeatureCollection", features: parts.flatMap((p) => p[0].features ?? []) },
      bldgs: { type: "FeatureCollection", features: parts.flatMap((p) => p[1].features ?? []) }
    };
  }

  function addCityLayers(mapInst) {
    if (!mapInst.getSource("lots")) mapInst.addSource("lots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!mapInst.getSource("bldgs")) mapInst.addSource("bldgs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!mapInst.getLayer("lots-pads")) mapInst.addLayer({
      id: "lots-pads", type: "fill", source: "lots", minzoom: 14,
      paint: { "fill-color": luColorExpr("landUse"), "fill-opacity": baseMode === "sat" ? 0.35 : 0.5, "fill-outline-color": "rgba(255,255,255,.35)" }
    });
    if (!mapInst.getLayer("bldgs-3d")) mapInst.addLayer({
      id: "bldgs-3d", type: "fill-extrusion", source: "bldgs", minzoom: 14,
      paint: {
        "fill-extrusion-color": luColorExpr("lu"),
        "fill-extrusion-height": ["get", "h"],
        "fill-extrusion-opacity": 0.92
      }
    });
    applyFilters();
  }

  async function refreshCity(mapInst) {
    if (mapInst.getZoom() < 14) { status("Zoom in to load the massing model"); return; }
    const { lots, bldgs } = await fetchCity(mapInst);
    if (closed || mlMap !== mapInst) return;
    mapInst.getSource("lots")?.setData(lots);
    mapInst.getSource("bldgs")?.setData(bldgs);
    status(bldgs.features.length ? "" : "No massing in view — pan toward a covered area");
  }

  async function bootMapLibre() {
    const gl = await loadMapLibre().catch(() => null);
    if (!gl || closed) { status("3D engine failed to load — check connection."); return; }
    const m = new gl.Map({
      container: el("#c3d-ml"),
      style: styleFor(baseMode),
      center: [lng, lat],
      zoom: Math.max(zoom, 15),
      pitch: 58,
      bearing: -29,
      maxPitch: 75,
      preserveDrawingBuffer: true,
      attributionControl: { compact: true }
    });
    mlMap = m;
    window.__map3d = m;
    m.addControl(new gl.NavigationControl({ visualizePitch: true }), "top-right");
    m.on("load", () => { addCityLayers(m); refreshCity(m); });
    m.on("moveend", () => refreshCity(m));
    m.on("click", "bldgs-3d", (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties;
      new gl.Popup({ closeButton: true, maxWidth: "260px" })
        .setLngLat(e.lngLat)
        .setHTML(`<b style="font-size:12.5px">${h(p.addr || `BBL ${p.bbl}`)}</b><br><a href="#/dossier?bbl=${p.bbl}" style="font-size:12px">Open dossier →</a>`)
        .addTo(m);
    });
    m.on("mouseenter", "bldgs-3d", () => { m.getCanvas().style.cursor = "pointer"; });
    m.on("mouseleave", "bldgs-3d", () => { m.getCanvas().style.cursor = ""; });
    renderLegend();
  }

  // -------------------------------------------------------------- Cesium LAB
  async function bootPhotorealistic() {
    const gate = el("#c3d-gate");
    gate.style.display = "none";
    status("Starting the city…");
    let sess;
    try { sess = await (await fetch("/api/3d-session")).json(); }
    catch { status("Could not reach the session service."); return; }
    if (closed) return;
    if (!sess.configured || sess.capped || !sess.key) {
      status("");
      gate.style.display = "";
      gate.innerHTML = sess.capped ? `
        <div class="card card-pad" style="max-width:420px">
          <b style="font-size:14px">Daily 3D session cap reached</b>
          <p class="sub" style="margin-top:8px">${sess.used} of ${sess.cap} sessions used today. This ceiling is ours, not Google's — it exists so a busy day can never turn into a surprise bill. It resets at midnight UTC, and the number is one line in the server.</p>
          <button class="btn" data-gate-back style="margin-top:12px;width:100%">Back to the 3D massing view</button>
        </div>` : `
        <div class="card card-pad" style="max-width:440px">
          <b style="font-size:14px">Photorealistic 3D isn't switched on yet</b>
          <ol style="margin:8px 0 0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--ink-mid)">
            <li>Google Cloud console → enable <b>Map Tiles API</b>.</li>
            <li>Create an API key restricted to <b>HTTP referrers</b> (your domain) and to the <b>Map Tiles API</b> only.</li>
            <li>Set a daily quota on the 3D Tiles SKU and a billing alert.</li>
            <li>Start the server with <span class="mono" style="font-size:11px">GOOGLE_3D_KEY=&lt;key&gt; npm start</span></li>
          </ol>
          <p class="note" style="margin-top:8px">Billing is per session (3 hours of unlimited flying), not per building: 1,000 free per month, then $0.006 each.</p>
          <button class="btn" data-gate-back style="margin-top:12px;width:100%">Back to the 3D massing view</button>
        </div>`;
      el("[data-gate-back]").addEventListener("click", () => switchEngine("ml"));
      return;
    }
    const Cesium = await loadCesium().catch(() => null);
    if (!Cesium || closed) { status("3D engine failed to load — check the connection."); return; }
    try {
      const viewer = new Cesium.Viewer(el("#c3d-ph"), {
        baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, animation: false,
        timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false
      });
      cesiumViewer = viewer;
      window.__map3dGoogle = viewer;
      const scene = viewer.scene;
      scene.globe.show = false;
      scene.skyAtmosphere.show = true;
      scene.backgroundColor = Cesium.Color.fromCssColorString("#0b1220");
      const tileset = await Cesium.Cesium3DTileset.fromUrl(
        `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(sess.key)}`,
        { showCreditsOnScreen: true }
      );
      if (closed) return;
      scene.primitives.add(tileset);
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lng, lat - 0.004, 520),
        orientation: { heading: Cesium.Math.toRadians(-29), pitch: Cesium.Math.toRadians(-32), roll: 0 },
        duration: 0
      });
      status("");
    } catch {
      status("3D tiles unavailable");
    }
  }

  // -------------------------------------------------------------- engine UI
  function switchEngine(eng) {
    els("#c3d-engine button").forEach((b) => b.classList.toggle("on", b.dataset.eng === eng));
    el("#c3d-ml").style.display = eng === "ml" ? "" : "none";
    el("#c3d-ph").style.display = eng === "ph" ? "" : "none";
    el("#c3d-base").style.display = eng === "ml" ? "" : "none";
    el("#c3d-legend").style.display = eng === "ml" ? "" : "none";
    el("#c3d-gate").style.display = "none";
    if (eng === "ph") bootPhotorealistic();
    else { status(""); mlMap?.resize(); }
  }
  els("#c3d-engine button").forEach((b) => b.addEventListener("click", () => switchEngine(b.dataset.eng)));
  els("#c3d-base button").forEach((b) => b.addEventListener("click", () => {
    baseMode = b.dataset.b;
    els("#c3d-base button").forEach((x) => x.classList.toggle("on", x === b));
    if (!mlMap) return;
    mlMap.setStyle(styleFor(baseMode));
    mlMap.once("style.load", () => { addCityLayers(mlMap); refreshCity(mlMap); });
  }));

  bootMapLibre();
  return { close };
}
