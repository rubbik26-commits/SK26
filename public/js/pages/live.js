// Live Details — walking the city: point your phone at a building and pull up
// its live record. Geolocation + compass lock-on, optional camera pass-through,
// and a pick-on-map fallback with tappable footprints.
import { api } from "../api.js";
import { el, els, h, toast, enhanceHScroll } from "../ui.js";

export async function mount(root) {
  let started = false, watchId = null, orientHandler = null, stream = null, map = null;
  const state = { pos: null, heading: null, nearby: [], footprints: [], mapMode: false, err: "" };

  root.innerHTML = `<div style="height:100%;position:relative" id="lv"></div>`;
  renderIntro();
  return { destroy: cleanup };

  function cleanup() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    if (orientHandler) { window.removeEventListener("deviceorientation", orientHandler, true); window.removeEventListener("deviceorientationabsolute", orientHandler, true); }
    stream?.getTracks().forEach((t) => t.stop());
    map?.remove(); map = null;
  }

  function renderIntro() {
    el("#lv").innerHTML = `
      <div class="scroll" style="height:100%"><div style="max-width:460px;margin:0 auto;padding:44px 20px;text-align:center">
        <div style="width:62px;height:62px;border-radius:18px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:var(--accent-ink)">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
        </div>
        <h1 class="page-title" style="font-size:21px">Live Details</h1>
        <p class="sub">Walking the city? Point your phone at a building and pull up its live record — owner, sales history, zoning, assessment, and the full Property Report.</p>
        <div style="display:grid;gap:8px;margin:18px 0;text-align:left">
          ${[["Uses your location to find the buildings around you"], ["Uses your compass to pick the one you're facing"], ["Optional camera view for an AR-style overlay"]].map(([t]) => `<div class="card" style="padding:11px 13px;font-size:12.5px">${h(t)}</div>`).join("")}
        </div>
        <button class="btn primary" id="lv-start" style="width:100%;justify-content:center;padding:12px;font-size:14px">Start Live Details</button>
        <p class="note" style="margin-top:10px">Your phone will ask for location (and camera/motion) access. Works best outdoors. Nothing is stored.</p>
        <p class="note" id="lv-err" style="color:var(--amber);margin-top:8px">${h(state.err)}</p>
        <button class="btn sm" id="lv-demo" style="margin-top:14px">No phone handy? Demo from a fixed point (Williamsburg)</button>
      </div></div>`;
    el("#lv-start").addEventListener("click", start);
    el("#lv-demo").addEventListener("click", () => { state.pos = { lat: 40.7127, lng: -73.9563, acc: 12 }; started = true; renderAr(); refreshNearby(); });
  }

  async function start() {
    state.err = "";
    if (!navigator.geolocation) { state.err = "Location isn't available on this device/browser."; return renderIntro(); }
    const opts = { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 };
    const ok = (pos) => {
      state.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      if (!started) { started = true; renderAr(); }
      refreshNearby();
    };
    const fail = (e2) => {
      state.err = e2?.code === 1
        ? "Location is blocked for this site. In Safari tap the “aA” (left of the address bar) → Website Settings → Location → Allow — then tap “Try again”."
        : e2?.code === 3 ? "Location timed out — make sure you have signal/are outdoors, then try again." : "Couldn't get your location. Try again.";
      if (!started) renderIntro();
    };
    navigator.geolocation.getCurrentPosition(ok, fail, opts);
    try { watchId = navigator.geolocation.watchPosition(ok, fail, opts); } catch {}
    orientHandler = (e2) => {
      let hdg = null;
      if (typeof e2.webkitCompassHeading === "number") hdg = e2.webkitCompassHeading;
      else if (typeof e2.alpha === "number") hdg = 360 - e2.alpha;
      if (hdg != null && Number.isFinite(hdg)) { state.heading = (hdg + 360) % 360; updateHud(); }
    };
    try {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === "function") {
        DOE.requestPermission().then((r) => { if (r === "granted") window.addEventListener("deviceorientation", orientHandler, true); }).catch(() => {});
      } else {
        window.addEventListener("deviceorientationabsolute", orientHandler, true);
        window.addEventListener("deviceorientation", orientHandler, true);
      }
    } catch {}
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      const v = el("#lv-video");
      if (v) { v.srcObject = stream; v.play().catch(() => {}); v.style.display = "block"; }
    } catch {}
  }

  async function refreshNearby() {
    if (!state.pos) return;
    try {
      const [n, f] = await Promise.all([
        api(`/api/nearby?lat=${state.pos.lat}&lng=${state.pos.lng}`, { fresh: true }),
        api(`/api/footprints?lat=${state.pos.lat}&lng=${state.pos.lng}`, { fresh: true })
      ]);
      state.nearby = n.buildings ?? [];
      state.footprints = f.features ?? [];
      updateHud(); renderCards(); drawMapLayers();
    } catch { toast("Couldn't load nearby buildings — check your connection."); }
  }

  const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const facing = () => state.heading == null ? null
    : state.nearby.map((b) => ({ b, diff: angDiff(b.bearing, state.heading) })).filter((x) => x.diff <= 18).sort((a, b) => a.diff - b.diff)[0]?.b ?? null;

  function renderAr() {
    el("#lv").innerHTML = `
      <div style="position:absolute;inset:0;background:linear-gradient(180deg,hsl(222 40% 22%),hsl(222 45% 8%));overflow:hidden">
        <video id="lv-video" playsinline muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none"></video>
        <div style="position:absolute;top:0;left:0;right:0;z-index:10;padding:10px 12px;background:linear-gradient(180deg,rgba(0,0,0,.55),transparent);display:flex;gap:12px;align-items:center;color:#fff;font-size:11.5px">
          <span id="lv-acc">locating…</span><span id="lv-hdg">no compass</span>
          <span style="flex:1"></span>
          <button class="btn sm" id="lv-map-toggle" style="background:#fff;color:#111;border-color:#fff;font-weight:800">Pick on map</button>
        </div>
        <div id="lv-lock" style="position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);z-index:5;text-align:center;width:min(46%,180px)"></div>
        <div id="lv-mapwrap" style="position:absolute;inset:0;z-index:30;display:none"><div id="lv-map" style="position:absolute;inset:0"></div>
          <div style="position:absolute;top:0;left:0;right:0;z-index:1000;padding:10px;background:linear-gradient(180deg,rgba(0,0,0,.5),transparent);pointer-events:none;color:#fff;font-size:12px;font-weight:650;text-align:center">Tap the exact building outline → report.</div></div>
        <div style="position:absolute;left:0;right:0;bottom:0;z-index:10;background:linear-gradient(0deg,rgba(0,0,0,.9),rgba(0,0,0,.55) 70%,transparent);padding:26px 12px 12px">
          <p style="color:rgba(255,255,255,.85);font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin:0 0 7px">Nearby properties</p>
          <div id="lv-cards" style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px"></div>
        </div>
      </div>`;
    el("#lv-map-toggle").addEventListener("click", () => {
      state.mapMode = !state.mapMode;
      el("#lv-mapwrap").style.display = state.mapMode ? "block" : "none";
      el("#lv-map-toggle").textContent = state.mapMode ? "Camera" : "Pick on map";
      if (state.mapMode && !map) initMap();
      if (map) setTimeout(() => map.invalidateSize(), 60);
    });
    updateHud(); renderCards();
  }

  function updateHud() {
    const acc = el("#lv-acc"), hdg = el("#lv-hdg"), lock = el("#lv-lock");
    if (!acc) return;
    acc.textContent = state.pos ? `±${Math.round(state.pos.acc ?? 0)}m` : "locating…";
    hdg.textContent = state.heading != null ? `${Math.round(state.heading)}°` : "no compass";
    const hit = facing();
    if (!lock) return;
    lock.innerHTML = hit ? `
      <button style="display:block;width:100%" data-lock="${hit.bbl}">
        <div style="height:min(50vh,300px);border-radius:14px;border:3px solid #3878ff;box-shadow:0 0 0 3px rgba(56,120,255,.55),0 0 36px 10px rgba(56,120,255,.6)"></div>
        <div style="margin-top:9px;background:#1f54c6;border-radius:11px;padding:8px 12px;color:#fff">
          <div style="font-weight:800;font-size:13.5px">${h(hit.address)}</div>
          <div style="font-size:11px;opacity:.85">${hit.units ? `${hit.units} units · ` : ""}${hit.distanceFt} ft · <b>Tap to open →</b></div>
        </div></button>`
      : `<div style="height:min(50vh,300px);border-radius:14px;border:2px dashed rgba(255,255,255,.5)"></div>
        <div style="margin-top:8px;display:inline-block;background:rgba(0,0,0,.55);border-radius:9px;padding:5px 11px;color:rgba(255,255,255,.9);font-size:11.5px">${state.heading == null ? "Move your phone to calibrate the compass… (desktop: use Pick on map)" : "Point at a building to lock on"}</div>`;
    lock.querySelector("[data-lock]")?.addEventListener("click", () => openDossier(hit.bbl, hit.address));
  }

  function renderCards() {
    const wrap = el("#lv-cards");
    if (!wrap) return;
    enhanceHScroll(wrap);
    const hit = facing();
    const rest = state.nearby.filter((b) => b.bbl !== hit?.bbl);
    wrap.innerHTML = rest.length ? rest.map((b) => `
      <button data-near="${b.bbl}" style="flex:none;width:200px;text-align:left;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.16);border-radius:13px;padding:11px 12px;color:#fff">
        <div style="font-weight:750;font-size:12.5px;line-height:1.3">${h(b.address)}</div>
        <div style="font-size:10.5px;opacity:.75;margin-top:2px">${b.units ? `${b.units} units` : ""}${b.yearBuilt ? ` · ${b.yearBuilt}` : ""}</div>
        <div style="font-size:10px;opacity:.55;margin-top:2px">${b.distanceFt} ft away · bearing ${b.bearing}°</div>
        <div style="margin-top:7px;display:inline-block;background:var(--accent);border-radius:7px;padding:4px 9px;font-size:11px;font-weight:700">Open report →</div>
      </button>`).join("")
      : `<span style="color:rgba(255,255,255,.7);font-size:12px;padding:8px 4px">${state.pos ? "No other lots within ~100m — move a little / go outdoors." : "Finding buildings around you…"}</span>`;
    els("[data-near]", wrap).forEach((b) => b.addEventListener("click", () => {
      const hit2 = state.nearby.find((x) => x.bbl === b.dataset.near);
      openDossier(b.dataset.near, hit2?.address);
    }));
  }

  function initMap() {
    map = L.map(el("#lv-map"), { zoomControl: true }).setView([state.pos.lat, state.pos.lng], 18);
    L.tileLayer("/api/mbtile/streets/{z}/{x}/{y}", { maxZoom: 20 }).addTo(map);
    L.circleMarker([state.pos.lat, state.pos.lng], { radius: 7, color: "#1f54c6", fillColor: "#3878ff", fillOpacity: 1, weight: 3 }).addTo(map);
    drawMapLayers();
  }
  let fpLayer = null;
  function drawMapLayers() {
    if (!map) return;
    if (fpLayer) map.removeLayer(fpLayer);
    fpLayer = L.layerGroup().addTo(map);
    for (const f of state.footprints) {
      L.geoJSON({ type: "Feature", geometry: f.geom, properties: { bbl: f.bbl } }, {
        style: () => ({ color: "#ffffff", weight: 1.5, fillColor: "#ffffff", fillOpacity: 0.12 })
      }).on("click", () => openDossier(f.bbl)).bindTooltip(`Tap → BBL ${f.bbl}`, { direction: "top", opacity: 0.9 }).addTo(fpLayer);
    }
    for (const b of state.nearby) {
      L.circleMarker([b.lat, b.lng], { radius: 6, color: "#c98a00", fillColor: "#f5c451", fillOpacity: 0.9, weight: 2 })
        .on("click", () => openDossier(b.bbl, b.address)).bindTooltip(h(b.address), { direction: "top", opacity: 0.9 }).addTo(fpLayer);
    }
  }
  function openDossier(bbl, address) {
    cleanup();
    window.location.hash = `#/dossier?bbl=${bbl}&addr=${encodeURIComponent(address ?? "")}`;
  }
}
