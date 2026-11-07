// Exact Owner Dossier/report imagery.
//
// This module is the handler production serves for /api/staticmap and
// /api/streetview — it is mounted at server.js:216, ahead of parity-routes
// (server.js:218) and routes (server.js:230), both of which also declare those
// two paths and are therefore shadowed. Mount order decides; the route table
// does not.
//
// PROVIDERS — measured 2026-08-19 against https://nycremarketintel.com by
// downloading the images the original serves and reading the attribution burnt
// into them:
//   /api/staticmap  -> Mapbox Static Images API. Every image carries the
//                      Mapbox wordmark bottom-left and "© Mapbox ©
//                      OpenStreetMap" bottom-right.
//   /api/streetview -> Google Street View Static API. The image carries the
//                      "Google" wordmark bottom-left and "© 2026 Google".
// The previous revision of this file proxied Google for BOTH families. That
// was wrong for /api/staticmap: it is Mapbox, and Google appears there only as
// the fallback documented below.
//
// The production bundle (public/assets/index-BbnE3o5g.js) calls /api/staticmap
// in three forms and /api/streetview in one:
//   * ?q=<address>&zoom=<n>&size=<WxH>&maptype=satellite   report/location maps
//   * ?pts=<lat,lng,label|...>&size=880x300                competitive-set map
//   * ?bbl=<10-digit BBL>                                  dossier/asset aerial
//   * /api/streetview?bbl=<10-digit BBL>
// The original also accepts ?lat=&lng= on both routes; the constants below
// carry the probe that fixed each one.
import { Router } from "express";
import { liveBuilding } from "./live.js";
import { incrementDurableUsage } from "./durable-cost.js";

const router = Router();
const cache = new Map();
const digits = (v) => String(v ?? "").replace(/[^0-9]/g, "");
const text = (v) => String(v ?? "").trim();
const mapboxToken = () => String(process.env.MAPBOX_ACCESS_TOKEN || "");
const googleKey = () => String((process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY) || "");

const MAPBOX_ORIGIN = "https://api.mapbox.com";

// Style, measured by rendering candidates and diffing them pixel-by-pixel
// against the images the original serves (900x300, q=Astoria, New York, NY):
//   satellite-streets-v12  meanAbsDiff 1.874   <- JPEG re-encode noise floor
//   satellite-streets-v11  meanAbsDiff 17.350
//   satellite-v9           meanAbsDiff 12.445
// and for maptype=roadmap (900x300, q=350 5th Ave, New York, NY):
//   streets-v12            meanAbsDiff 0.325   <- PNG dither noise floor
//   streets-v11            meanAbsDiff 7.974
//   light-v11              meanAbsDiff 20.316
const SATELLITE_STYLE = "satellite-streets-v12";
const STREETS_STYLE = "streets-v12";

// The point form (?bbl= and ?lat=&lng=) is a FIXED composition: the original
// ignores size, zoom and maptype on it. Measured — all three of
//   ?bbl=1008350041, ?bbl=1008350041&size=300x200, ?bbl=1008350041&maptype=roadmap
// return the identical 89545-byte image, and ?bbl=1008350041&zoom=10 likewise.
// Dimensions read out of the JPEG SOF marker: 640x360.
// Zoom solved by pixel diff against ?lat=40.7484&lng=-73.9857:
//   z17 meanAbsDiff 1.717   <- noise floor      z18 60.122      z16 64.130
const POINT_SIZE = "640x360";
const POINT_ZOOM = 17;

// The q form's defaults, measured on q=Astoria, New York, NY: the responses to
// ?q=<a>, ?q=<a>&size=900x300&maptype=satellite and ?q=<a>&zoom=14&size=900x300
// &maptype=satellite are all byte-identical at 124323 bytes, and the image is
// 900x300. So an absent zoom means 14, an absent size means 900x300 and an
// absent maptype means satellite.
const Q_SIZE = "900x300";

// The q form's zoom sanitiser, solved from the full sweep on the same address
// (900x300, satellite), byte lengths:
//   <none> 124323 | 0 124323 | 1 125566 | 13 120118 | 14 124323 | 15 140509
//   16 133264 | 17 133264 | 18 133264 | 20 133264 | 21 133264 | 22 133264
//   99 133264 | -5 125566 | 1.5 125566 | abc 124323
// So: a non-finite or zero zoom falls back to 14; 1.5 and -5 both land on 1
// (truncated, then floored at 1); everything from 16 up is capped at 16.
const Q_ZOOM_DEFAULT = 14;
const Q_ZOOM_MIN = 1;
const Q_ZOOM_MAX = 16;

// The pts form. Default size measured: ?pts=<two points> and the same request
// with &size=880x300 are byte-identical at 107419 bytes, and &size=400x200
// returns a 400x200 image, so size is honoured with an 880x300 default.
// maptype is NOT honoured: &maptype=satellite returns the identical 107419
// bytes, i.e. always the streets style.
// The viewport is Mapbox's /auto/ fit with padding=40, solved by sweep against
// the original's two-point image (mean absolute pixel difference, 880x300):
//   pad=40 0.447  <- noise floor
//   pad=35 19.658  pad=45 20.034  pad=30 22.247  pad=25 23.033  pad=0 25.770
const PTS_SIZE = "880x300";
const PTS_PADDING = 40;

// Marker colours.
//   primary (the first point): #ff3b30. Solved on the point form, which is a
//   truecolor JPEG and therefore an exact oracle — mean absolute difference
//   over the pin box: ff3b30 1.512, ff3b2f 1.900, ff3b31 2.126, ff3b2e ~4.8,
//   ff4136 8.82, f00 37.11. Confirmed independently on the palette PNG of the
//   pts form: rendering ff3b30 quantises the pin interior to 246,58,49 across
//   exactly 356 pixels, which is what the original publishes.
//   secondary (every later point): #1f54c6, the app's own brand blue — it
//   appears 34 times in the immutable bundle and no other candidate appears at
//   all. Rendering it quantises the three secondary pins to 33,85,198 across
//   exactly 1034 pixels, which is what the original publishes.
const MARKER_PRIMARY = "ff3b30";
const MARKER_SECONDARY = "1f54c6";

// Street View is 640x360 and ignores size: ?bbl=1008350041 and
// ?bbl=1008350041&size=300x200 return the identical 19351-byte image.
const STREETVIEW_SIZE = "640x360";

// Two different cache lifetimes, measured off the original's own responses:
// the point form and Street View answer "public, max-age=86400"; the q and pts
// forms answer "public, max-age=604800".
const POINT_CACHE_CONTROL = "public, max-age=86400";
const AREA_CACHE_CONTROL = "public, max-age=604800";

// The original's rejection bodies, measured. GET /api/staticmap,
// /api/staticmap?q=, /api/staticmap?pts=, /api/staticmap?lat=&lng=,
// /api/staticmap?lat=40.7484 (lng missing), /api/staticmap?bbl=100835004,
// /api/staticmap?bbl=9999999999, /api/staticmap?center=…, /api/staticmap?address=…,
// GET /api/streetview and /api/streetview?bbl=9999999999 all answer
//   404  content-type: text/plain;charset=UTF-8  body: "No location"  (11 bytes)
// while /api/staticmap?pts=notanumber — pts supplied but no segment parses —
// answers
//   404  content-type: text/plain;charset=UTF-8  body: "No points"    (9 bytes)
// Neither carries a cache-control header.
const NO_LOCATION = "No location";
const NO_POINTS = "No points";
// res.send() would rewrite the header as "text/plain; charset=utf-8" — a space
// and a lower-case charset the original does not send — so the header and the
// length are written verbatim and the body is ended directly.
const plain = (res, body) =>
  res.status(404)
    .set("content-type", "text/plain;charset=UTF-8")
    .set("content-length", String(Buffer.byteLength(body)))
    .end(body);

function cachedImage(key) {
  const hit = cache.get(key);
  return hit && hit.expires > Date.now() ? hit : null;
}
const sendCached = (res, hit, cacheControl) =>
  res.set("content-type", hit.type).set("cache-control", cacheControl).send(hit.buf);

// Fetches one upstream image and reports the outcome instead of writing a
// response, because a non-ok primary is not an error here — it is the trigger
// for the measured Google fallback below. Nothing is swallowed: a transport
// failure propagates to the route, which reports it.
async function fetchImage(url) {
  const r = await fetch(url, {
    headers: { "user-agent": "nyc-re-market-intel/production" },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) return { ok: false, status: r.status };
  return {
    ok: true,
    buf: Buffer.from(await r.arrayBuffer()),
    type: r.headers.get("content-type") || "image/jpeg"
  };
}

function storeImage(key, image) {
  if (cache.size >= 500) cache.clear();
  cache.set(key, { buf: image.buf, type: image.type, expires: Date.now() + 24 * 60 * 60 * 1000 });
}

function safeSize(value, fallback) {
  const v = String(value || "").trim();
  return /^\d{2,4}x\d{2,4}$/i.test(v) ? v.toLowerCase() : fallback;
}

// Google's own zoom range, kept for the fallback URL builder below.
function safeZoom(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 22 ? String(n) : "";
}

// Google's own maptype vocabulary, kept for the fallback URL builder below.
function safeMapType(value, fallback = "") {
  const v = String(value || "").trim().toLowerCase();
  return ["roadmap", "satellite", "terrain", "hybrid"].includes(v) ? v : fallback;
}

// Only maptype=roadmap changes the Mapbox style. Measured on
// q=Astoria, New York, NY at zoom 14, 900x300: satellite, terrain, hybrid, a
// bogus value and an absent value all return the identical 124323-byte JPEG,
// while roadmap returns a 92349-byte PNG.
function mapboxStyle(value) {
  return String(value || "").trim().toLowerCase() === "roadmap" ? STREETS_STYLE : SATELLITE_STYLE;
}

function mapboxZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return String(Q_ZOOM_DEFAULT);
  return String(Math.min(Q_ZOOM_MAX, Math.max(Q_ZOOM_MIN, Math.trunc(n))));
}

// The label a point carries when its own label field is absent or unusable.
// Measured: ?pts=40.75,-73.98|40.74,-73.99|40.73,-74.00|40.72,-73.97 (no label
// fields at all) returns exactly the same 107979 bytes as the same four points
// labelled S|A|B|C, and matches a render of pin-s-s, pin-s-a, pin-s-b, pin-s-c
// (115 differing pixels of 264000) rather than a, b, c, d (277). Two-character
// labels "SS" and "AB" produce the same image as "s" and "a", so a supplied
// label is its first character, lower-cased.
function defaultLabel(index) {
  return index === 0 ? "s" : String.fromCharCode(97 + Math.min(index - 1, 25));
}

function mapboxMarkers(pts) {
  const markers = [];
  for (const raw of String(pts).split("|")) {
    const [latRaw, lngRaw, labelRaw = ""] = raw.split(",");
    const lat = Number(latRaw), lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const supplied = String(labelRaw).trim().toLowerCase().slice(0, 1);
    const label = /^[a-z0-9]$/.test(supplied) ? supplied : defaultLabel(markers.length);
    const colour = markers.length === 0 ? MARKER_PRIMARY : MARKER_SECONDARY;
    markers.push(`pin-s-${label}+${colour}(${lng},${lat})`);
  }
  return markers.length ? markers.join(",") : null;
}

// Which point the request resolves to, and in which order. Measured on the
// original: ?lat=40.7484&lng=-73.9857&bbl=1000160001 returns the same 90369
// bytes as ?lat=40.7484&lng=-73.9857 alone, so an explicit coordinate outranks
// a BBL; and ?q=…&pts=… returns the q image while ?pts=…&lat=&lng= returns the
// pts image, so the full order is q, then pts, then lat/lng, then bbl.
// The coordinate is passed through as supplied and NOT validated: the original
// answers ?lat=abc&lng=-73.9857 with a 200 rather than a rejection, because the
// malformed centre fails at the provider and lands on the fallback.
function explicitPoint(query) {
  const lat = text(query?.lat), lng = text(query?.lng);
  return lat && lng ? { lat, lng } : null;
}

const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const GEOCODE_MAX_ENTRIES = 500;
const geocodeCache = new Map();

// The q form needs a coordinate before it can ask for an image, so the address
// goes through Mapbox geocoding first. Measured: the original renders
// q=350 5th Ave, New York, NY at -73.984612,40.672196 — the BROOKLYN Fifth
// Avenue — which is exactly what mapbox.places returns as its first result, and
// the render matches at 1.843 mean absolute difference (noise floor). Mapbox
// geocoding v5 and v6 return identical centres for both probed addresses, so
// this measurement cannot separate them; v5 is used.
async function geocodeAddress(query, token) {
  const key = query.toLowerCase();
  const hit = geocodeCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.centre;
  const url = `${MAPBOX_ORIGIN}/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=1&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, {
    headers: { "user-agent": "nyc-re-market-intel/production" },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) return null;
  const body = await r.json();
  const centre = body?.features?.[0]?.center;
  if (!Array.isArray(centre) || centre.length < 2) return null;
  const lng = Number(centre[0]), lat = Number(centre[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (geocodeCache.size >= GEOCODE_MAX_ENTRIES) geocodeCache.clear();
  const resolved = { lat, lng };
  geocodeCache.set(key, { centre: resolved, expires: Date.now() + GEOCODE_TTL_MS });
  return resolved;
}

// Pure URL builder so the exact bundle query shapes can be regression-tested
// without making a paid render. `token` is accepted only as an argument and is
// never logged or returned by the product API.
export function buildStaticMapUrl(query, { token, building = null, centre = null } = {}) {
  if (!token) return null;
  const access = `access_token=${encodeURIComponent(token)}`;
  const q = text(query?.q);
  const pts = text(query?.pts);

  if (q) {
    if (!centre || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lng)) return null;
    const size = safeSize(query?.size, Q_SIZE);
    return `${MAPBOX_ORIGIN}/styles/v1/mapbox/${mapboxStyle(query?.maptype)}/static/` +
      `${centre.lng},${centre.lat},${mapboxZoom(query?.zoom)}/${size}?${access}`;
  }

  if (pts) {
    const markers = mapboxMarkers(pts);
    if (!markers) return null;
    const size = safeSize(query?.size, PTS_SIZE);
    return `${MAPBOX_ORIGIN}/styles/v1/mapbox/${STREETS_STYLE}/static/${markers}/auto/${size}` +
      `?padding=${PTS_PADDING}&${access}`;
  }

  const point = explicitPoint(query) ||
    (digits(query?.bbl).length === 10 && building?.lat != null && building?.lng != null
      ? { lat: String(building.lat), lng: String(building.lng) }
      : null);
  if (!point) return null;
  const lat = encodeURIComponent(point.lat), lng = encodeURIComponent(point.lng);
  return `${MAPBOX_ORIGIN}/styles/v1/mapbox/${SATELLITE_STYLE}/static/` +
    `pin-s+${MARKER_PRIMARY}(${lng},${lat})/${lng},${lat},${POINT_ZOOM}/${POINT_SIZE}?${access}`;
}

// The measured fallback. When the Mapbox render fails, the original serves a
// Google Static Maps response instead — proven by three probes whose bodies are
// Google's own error tile, watermarked "Google" and "Map error:
// g.co/staticmaperror":
//   ?q=zzzzzzqqqq nowhere xyzzy 999      -> 640x300 PNG   (Mapbox cannot geocode it)
//   ?q=…&size=1400x400                   -> 640x400 PNG   (over Mapbox's size ceiling)
//   ?lat=abc&lng=-73.9857                -> 640x360 PNG   (unparseable centre)
// The returned dimensions track the size this builder asks for, clamped to
// Google's own 640 maximum, which is how the requested size is known to be
// forwarded unchanged.
export function buildStaticMapFallbackUrl(query, { key, building = null } = {}) {
  if (!key) return null;
  const params = new URLSearchParams();
  const q = text(query?.q);
  const pts = text(query?.pts);

  if (q) {
    params.set("center", q);
    const zoom = safeZoom(query?.zoom);
    if (zoom) params.set("zoom", zoom);
    params.set("size", safeSize(query?.size, Q_SIZE));
    const maptype = safeMapType(query?.maptype, "satellite");
    if (maptype) params.set("maptype", maptype);
  } else if (pts) {
    const markers = String(pts).split("|").map((raw) => {
      const [latRaw, lngRaw, labelRaw = ""] = raw.split(",");
      const lat = Number(latRaw), lng = Number(lngRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const label = String(labelRaw || "").trim().toUpperCase().slice(0, 1);
      const location = `${lat},${lng}`;
      return label && /^[A-Z0-9]$/.test(label) ? `label:${label}|${location}` : location;
    }).filter(Boolean);
    if (!markers.length) return null;
    params.set("size", safeSize(query?.size, PTS_SIZE));
    for (const marker of markers) params.append("markers", marker);
  } else {
    const point = explicitPoint(query) ||
      (digits(query?.bbl).length === 10 && building?.lat != null && building?.lng != null
        ? { lat: String(building.lat), lng: String(building.lng) }
        : null);
    if (!point) return null;
    params.set("size", safeSize(query?.size, POINT_SIZE));
    params.set("maptype", "satellite");
    params.append("markers", `${point.lat},${point.lng}`);
  }

  params.set("key", key);
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

// Renders through Mapbox, falls back to Google exactly where the original does,
// and never invents an image when neither provider can be reached.
async function renderStaticMap(res, { query, building, cacheKey, cacheControl, provider }) {
  const hit = cachedImage(cacheKey);
  if (hit) return sendCached(res, hit, cacheControl);

  let attempted = false;
  if (provider.url) {
    const meter = await incrementDurableUsage("staticmap", 1);
    if (!meter.ok) return res.status(503).json({ error: "durable_meter_unavailable" });
    attempted = true;
    const image = await fetchImage(provider.url);
    if (image.ok) {
      storeImage(cacheKey, image);
      return res.set("content-type", image.type).set("cache-control", cacheControl).send(image.buf);
    }
  }

  const fallbackUrl = buildStaticMapFallbackUrl(query, { key: googleKey(), building });
  if (fallbackUrl) {
    // A second provider means a second billable render, so it is metered
    // separately rather than folded into the first.
    const meter = await incrementDurableUsage("staticmap", 1);
    if (!meter.ok) return res.status(503).json({ error: "durable_meter_unavailable" });
    attempted = true;
    const image = await fetchImage(fallbackUrl);
    if (image.ok) {
      storeImage(cacheKey, image);
      return res.set("content-type", image.type).set("cache-control", cacheControl).send(image.buf);
    }
  }

  if (!attempted) {
    return res.status(503).json({
      error: "staticmap_unconfigured",
      message: "MAPBOX_ACCESS_TOKEN is not set and no GOOGLE_MAPS_API_KEY fallback is available, so no map can be rendered."
    });
  }
  return res.status(502).json({ error: "staticmap_upstream_failed" });
}

router.get("/api/staticmap", async (req, res) => {
  const q = text(req.query.q);
  const pts = text(req.query.pts);
  const token = mapboxToken();

  try {
    if (q) {
      const centre = token ? await geocodeAddress(q, token) : null;
      const url = buildStaticMapUrl(req.query, { token, centre });
      return await renderStaticMap(res, {
        query: req.query, building: null,
        cacheKey: `staticmap:q:${q.toLowerCase()}:${safeSize(req.query.size, Q_SIZE)}:${mapboxZoom(req.query.zoom)}:${mapboxStyle(req.query.maptype)}`,
        cacheControl: AREA_CACHE_CONTROL,
        provider: { url }
      });
    }

    if (pts) {
      const markers = mapboxMarkers(pts);
      // pts supplied but not one segment parses: the original's "No points".
      if (!markers) return plain(res, NO_POINTS);
      const url = buildStaticMapUrl(req.query, { token });
      return await renderStaticMap(res, {
        query: req.query, building: null,
        cacheKey: `staticmap:pts:${markers}:${safeSize(req.query.size, PTS_SIZE)}`,
        cacheControl: AREA_CACHE_CONTROL,
        provider: { url }
      });
    }

    const explicit = explicitPoint(req.query);
    const bbl = digits(req.query.bbl);
    let building = null;
    if (!explicit) {
      if (bbl.length !== 10) return plain(res, NO_LOCATION);
      building = await liveBuilding(bbl);
      if (!building?.lat || !building?.lng) return plain(res, NO_LOCATION);
    }
    const point = explicit || { lat: String(building.lat), lng: String(building.lng) };
    const url = buildStaticMapUrl(req.query, { token, building });
    return await renderStaticMap(res, {
      query: req.query, building,
      cacheKey: `staticmap:point:${point.lat},${point.lng}`,
      cacheControl: POINT_CACHE_CONTROL,
      provider: { url }
    });
  } catch (err) {
    // Reported, not swallowed: the caller learns the render failed and why.
    return res.status(502).json({ error: "staticmap_upstream_failed", message: String(err?.message || err) });
  }
});

router.get("/api/streetview", async (req, res) => {
  try {
    // The location is resolved before the credential is consulted, so the
    // measurable rejections ("No location") stay byte-exact even where Street
    // View itself cannot be served.
    const explicit = explicitPoint(req.query);
    const bbl = digits(req.query.bbl);
    let building = null;
    if (!explicit) {
      if (bbl.length !== 10) return plain(res, NO_LOCATION);
      building = await liveBuilding(bbl);
      if (!building?.lat || !building?.lng) return plain(res, NO_LOCATION);
    }
    const point = explicit || { lat: String(building.lat), lng: String(building.lng) };

    const cacheKey = `streetview:${point.lat},${point.lng}`;
    const hit = cachedImage(cacheKey);
    if (hit) return sendCached(res, hit, POINT_CACHE_CONTROL);

    const key = googleKey();
    if (!key) {
      return res.status(503).json({
        error: "streetview_unconfigured",
        message: "GOOGLE_MAPS_API_KEY is not set, so Street View cannot be served."
      });
    }

    const meter = await incrementDurableUsage("streetview", 1);
    if (!meter.ok) return res.status(503).json({ error: "durable_meter_unavailable" });

    const url = `https://maps.googleapis.com/maps/api/streetview?size=${STREETVIEW_SIZE}` +
      `&location=${encodeURIComponent(point.lat)},${encodeURIComponent(point.lng)}&key=${encodeURIComponent(key)}`;
    const image = await fetchImage(url);
    if (!image.ok) return res.status(502).json({ error: "streetview_upstream_failed", status: image.status });
    storeImage(cacheKey, image);
    return res.set("content-type", image.type).set("cache-control", POINT_CACHE_CONTROL).send(image.buf);
  } catch (err) {
    return res.status(502).json({ error: "streetview_upstream_failed", message: String(err?.message || err) });
  }
});

export default router;
