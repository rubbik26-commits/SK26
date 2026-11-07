// Market Stadium shell layer — map attachment.
//
// Renders a small choropleth of the active geography level inside lucia, using
// the vendored MapLibre build (never a CDN — the shell must not depend on a
// third party being reachable). The full interactive surface stays at /market/;
// this is the in-lucia context map.
//
// The map is created once and its data is swapped on level change. A `ready`
// epoch counter — not a boolean latch — guards the layer add: React/StrictMode
// style double-mounting would otherwise let a removed instance latch "ready"
// and the surviving map would never receive its layers.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.map) return;

  const VENDOR = "/vendor/maplibre/maplibre-gl.js";
  const VENDOR_CSS = "/vendor/maplibre/maplibre-gl.css";

  let map = null;
  let readyEpoch = 0;
  let loadedEpoch = 0;
  let currentLevel = null;

  function ensureCss() {
    if (document.querySelector('link[data-ms-maplibre]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = VENDOR_CSS;
    link.dataset.msMaplibre = "1";
    document.head.appendChild(link);
  }

  function ensureLib() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (window.__msMaplibreLoading) return window.__msMaplibreLoading;
    window.__msMaplibreLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = VENDOR;
      script.onload = () => resolve(window.maplibregl);
      script.onerror = () => reject(new Error("vendored MapLibre failed to load"));
      document.head.appendChild(script);
    });
    return window.__msMaplibreLoading;
  }

  const EMPTY_STYLE = {
    version: 8,
    sources: {},
    layers: [{ id: "bg", type: "background", paint: { "background-color": "#0b1b2b" } }]
  };

  async function mount(container, level) {
    ensureCss();
    const lib = await ensureLib();
    if (!container.isConnected) return null;

    if (!map) {
      map = new lib.Map({
        container,
        style: EMPTY_STYLE,
        center: [-73.97, 40.75],
        zoom: 8,
        attributionControl: false
      });
      const epoch = ++readyEpoch;
      map.on("load", () => {
        loadedEpoch = epoch;
      });
    }
    await draw(level);
    return map;
  }

  async function draw(level) {
    if (!map) return;
    // Wait for this instance's own load event, not any earlier one.
    for (let i = 0; i < 100 && loadedEpoch !== readyEpoch; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (loadedEpoch !== readyEpoch) return;

    const geo = await LMS.api.json(`/api/market/geo/${level}`);
    const places = await LMS.api.json(`/api/market/places/${level}`);
    const byId = new Map((Array.isArray(places) ? places : []).map((p) => [String(p.geoid), p]));

    const features = (geo?.features ?? []).map((f) => {
      const geoid = String(f.properties?.geoid ?? f.id ?? "");
      const place = byId.get(geoid);
      const score = typeof place?.mscor001c1 === "number" ? place.mscor001c1 : null;
      return {
        type: "Feature",
        geometry: f.geometry,
        properties: {
          geoid,
          name: place?.name ?? f.properties?.name ?? geoid,
          score,
          tier: LMS.tierFromScore(score),
          color: LMS.tierColor(LMS.tierFromScore(score))
        }
      };
    });

    const sourceId = "ms-places";
    const layerId = "ms-fill";
    const lineId = "ms-line";
    // Remove in dependency order: every layer that uses the source must go
    // before the source itself, or MapLibre refuses the removal.
    for (const id of [lineId, layerId]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    map.addSource(sourceId, {
      type: "geojson",
      data: { type: "FeatureCollection", features }
    });
    map.addLayer({
      id: layerId,
      type: "fill",
      source: sourceId,
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.82 }
    });
    map.addLayer({
      id: lineId,
      type: "line",
      source: sourceId,
      paint: { "line-color": "#0b1b2b", "line-width": 0.4 }
    });

    currentLevel = level;
    try {
      const bounds = new (window.maplibregl.LngLatBounds)();
      for (const f of features) {
        const walk = (coords) => {
          if (typeof coords[0] === "number") bounds.extend(coords);
          else coords.forEach(walk);
        };
        if (f.geometry?.coordinates) walk(f.geometry.coordinates);
      }
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 24, duration: 0 });
    } catch {
      /* bounds are cosmetic — a failure must not blank the map */
    }
  }

  LMS.map = { mount, draw, get instance() { return map; }, get level() { return currentLevel; } };
})();
