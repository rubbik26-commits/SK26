import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildStaticMapUrl, buildStaticMapFallbackUrl } from "../server/production-imagery.js";

const TOKEN = "test-mapbox-token";
const KEY = "test-google-key";

// Re-pinned 2026-08-19. The previous revision of this file asserted that
// /api/staticmap builds a Google Static Maps URL. That was measurably wrong:
// every image https://nycremarketintel.com serves on /api/staticmap carries the
// Mapbox wordmark and "© Mapbox © OpenStreetMap" burnt into it, and rendering
// the URLs asserted below reproduces the original's own images to within the
// JPEG/PNG re-encode noise floor:
//   bbl aerial      640x360  meanAbsPixelDiff 1.625   q default   900x300  1.874
//   lat/lng aerial  640x360  1.717                    q roadmap   900x300  0.356
//   pts 2 labelled  880x300  0.326                    pts 4 lbl   880x300  0.318
// Google survives only as the fallback the original uses when the Mapbox render
// fails, which is asserted separately below.
function mapbox(url) {
  assert.ok(url, "expected a Mapbox Static Images URL");
  const u = new URL(url);
  assert.equal(u.origin, "https://api.mapbox.com");
  assert.equal(u.searchParams.get("access_token"), TOKEN);
  return u;
}

function google(url) {
  assert.ok(url, "expected a Google Static Maps fallback URL");
  const u = new URL(url);
  assert.equal(u.origin, "https://maps.googleapis.com");
  assert.equal(u.pathname, "/maps/api/staticmap");
  assert.equal(u.searchParams.get("key"), KEY);
  return u;
}

test("Owner report q-form renders the geocoded centre at the composition the bundle asks for", () => {
  const u = mapbox(buildStaticMapUrl({
    q: "220 East 42nd Street, Manhattan, NY",
    zoom: "14",
    size: "900x300",
    maptype: "satellite"
  }, { token: TOKEN, centre: { lat: 40.7503, lng: -73.9718 } }));
  assert.equal(u.pathname,
    "/styles/v1/mapbox/satellite-streets-v12/static/-73.9718,40.7503,14/900x300");
});

test("Owner report q-form defaults are zoom 14, 900x300 and the satellite style", () => {
  // Measured on the original: ?q=Astoria, New York, NY and the same request
  // with &zoom=14&size=900x300&maptype=satellite return byte-identical
  // 124323-byte 900x300 images.
  const u = mapbox(buildStaticMapUrl({ q: "Astoria, New York, NY" },
    { token: TOKEN, centre: { lat: 40.762447, lng: -73.91948 } }));
  assert.equal(u.pathname,
    "/styles/v1/mapbox/satellite-streets-v12/static/-73.91948,40.762447,14/900x300");
});

test("Owner report q-form zoom is clamped to 1..16 and falls back to 14", () => {
  // The original's own zoom sweep (900x300 satellite, q=Astoria, New York, NY),
  // byte lengths: 16/17/18/20/21/22/99 all 133264 (capped at 16); 1, -5 and 1.5
  // all 125566 (floored at 1, truncated); absent, 0 and "abc" all 124323 (= 14).
  const zoomOf = (zoom) => new URL(buildStaticMapUrl({ q: "x", zoom },
    { token: TOKEN, centre: { lat: 1, lng: 2 } })).pathname.split("/").at(-2).split(",")[2];
  assert.equal(zoomOf(undefined), "14");
  assert.equal(zoomOf("0"), "14");
  assert.equal(zoomOf("abc"), "14");
  assert.equal(zoomOf("13"), "13");
  assert.equal(zoomOf("1.5"), "1");
  assert.equal(zoomOf("-5"), "1");
  assert.equal(zoomOf("16"), "16");
  assert.equal(zoomOf("99"), "16");
});

test("Owner report q-form switches style only for maptype=roadmap", () => {
  // Measured: satellite, terrain, hybrid, a bogus value and an absent value all
  // return the identical 124323-byte JPEG; roadmap returns a 92349-byte PNG.
  const styleOf = (maptype) => new URL(buildStaticMapUrl({ q: "x", maptype },
    { token: TOKEN, centre: { lat: 1, lng: 2 } })).pathname.split("/")[4];
  assert.equal(styleOf("roadmap"), "streets-v12");
  for (const m of [undefined, "satellite", "terrain", "hybrid", "bogus"]) {
    assert.equal(styleOf(m), "satellite-streets-v12", `maptype=${m}`);
  }
});

test("Owner competitive-set pts-form labels the first point red and the rest brand blue", () => {
  const u = mapbox(buildStaticMapUrl({
    pts: "40.7484,-73.9857,S|40.749,-73.986,A|40.75,-73.987,B",
    size: "880x300"
  }, { token: TOKEN }));
  assert.equal(u.pathname, "/styles/v1/mapbox/streets-v12/static/" +
    "pin-s-s+ff3b30(-73.9857,40.7484)," +
    "pin-s-a+1f54c6(-73.986,40.749)," +
    "pin-s-b+1f54c6(-73.987,40.75)/auto/880x300");
  assert.equal(u.searchParams.get("padding"), "40");
});

test("Owner competitive-set pts-form defaults absent labels to s, a, b, c by position", () => {
  // Measured on the original: four points with NO label field return exactly
  // the same 107979 bytes as the same four points labelled S|A|B|C.
  const u = mapbox(buildStaticMapUrl({
    pts: "40.75,-73.98|40.74,-73.99|40.73,-74|40.72,-73.97"
  }, { token: TOKEN }));
  assert.deepEqual(u.pathname.split("/static/")[1].split("/auto/")[0].split(","),
    ["pin-s-s+ff3b30(-73.98", "40.75)", "pin-s-a+1f54c6(-73.99", "40.74)",
     "pin-s-b+1f54c6(-74", "40.73)", "pin-s-c+1f54c6(-73.97", "40.72)"]);
});

test("Owner competitive-set pts-form takes the first character of a supplied label", () => {
  // Measured: labels "SS" and "AB" return the same image as "s" and "a".
  const u = mapbox(buildStaticMapUrl({ pts: "40.75,-73.98,SS|40.74,-73.99,AB" }, { token: TOKEN }));
  assert.match(u.pathname, /pin-s-s\+ff3b30/);
  assert.match(u.pathname, /pin-s-a\+1f54c6/);
});

test("Owner competitive-set pts-form ignores maptype and defaults to 880x300", () => {
  // Measured: ?pts=<two points> , the same with &size=880x300 and the same with
  // &maptype=satellite all return the identical 107419-byte PNG.
  const bare = mapbox(buildStaticMapUrl({ pts: "40.75,-73.98,S|40.74,-73.99,A" }, { token: TOKEN }));
  const typed = mapbox(buildStaticMapUrl({ pts: "40.75,-73.98,S|40.74,-73.99,A", maptype: "satellite" }, { token: TOKEN }));
  assert.equal(bare.pathname, typed.pathname);
  assert.match(bare.pathname, /\/auto\/880x300$/);
  assert.match(bare.pathname, /^\/styles\/v1\/mapbox\/streets-v12\//);
});

test("Owner BBL aerial is a fixed 640x360 zoom-17 satellite pin at the live parcel coordinate", () => {
  // Measured: ?bbl=1008350041, &size=300x200 and &maptype=roadmap all return
  // the identical 89545-byte 640x360 image, so size and maptype are ignored;
  // zoom solved by pixel diff (z17 1.717 vs z18 60.122 vs z16 64.130).
  const u = mapbox(buildStaticMapUrl({ bbl: "1008350041", size: "300x200", maptype: "roadmap" }, {
    token: TOKEN,
    building: { lat: 40.7484, lng: -73.9857 }
  }));
  assert.equal(u.pathname, "/styles/v1/mapbox/satellite-streets-v12/static/" +
    "pin-s+ff3b30(-73.9857,40.7484)/-73.9857,40.7484,17/640x360");
});

test("an explicit lat/lng outranks a BBL and is passed through unvalidated", () => {
  // Measured: ?lat=40.7484&lng=-73.9857&bbl=1000160001 returns the same 90369
  // bytes as ?lat=40.7484&lng=-73.9857 alone; and ?lat=abc&lng=-73.9857 answers
  // 200, not a rejection, because the malformed centre fails at the provider.
  const u = mapbox(buildStaticMapUrl({ lat: "40.7484", lng: "-73.9857", bbl: "1000160001" }, {
    token: TOKEN, building: { lat: 40.7, lng: -73.9 }
  }));
  assert.match(u.pathname, /pin-s\+ff3b30\(-73\.9857,40\.7484\)/);
  const bad = mapbox(buildStaticMapUrl({ lat: "abc", lng: "-73.9857" }, { token: TOKEN }));
  assert.match(bad.pathname, /\(-73\.9857,abc\)/);
});

test("invalid static-map input is rejected rather than replaced with guessed geography", () => {
  assert.equal(buildStaticMapUrl({ pts: "not-a-coordinate" }, { token: TOKEN }), null);
  assert.equal(buildStaticMapUrl({ bbl: "1008350041" }, { token: TOKEN, building: null }), null);
  assert.equal(buildStaticMapUrl({ q: "Manhattan" }, { token: TOKEN, centre: null }), null);
  assert.equal(buildStaticMapUrl({ q: "Manhattan" }, { token: "" }), null);
});

test("the Google fallback carries the same requested size as the Mapbox primary", () => {
  // Measured on the original — the fallback bodies are Google's own error tile,
  // and their dimensions track the requested size clamped to Google's 640 max:
  //   ?q=<ungeocodable>            -> 640x300  (asked for 900x300)
  //   ?q=<ungeocodable>&size=400x200 -> 400x200
  //   ?lat=abc&lng=-73.9857        -> 640x360  (the point form's fixed size)
  assert.equal(google(buildStaticMapFallbackUrl({ q: "nowhere" }, { key: KEY })).searchParams.get("size"), "900x300");
  assert.equal(google(buildStaticMapFallbackUrl({ q: "nowhere", size: "400x200" }, { key: KEY })).searchParams.get("size"), "400x200");
  assert.equal(google(buildStaticMapFallbackUrl({ lat: "abc", lng: "-73.9857" }, { key: KEY })).searchParams.get("size"), "640x360");
  assert.equal(buildStaticMapFallbackUrl({ q: "nowhere" }, { key: "" }), null);
});

test("authoritative Owner imagery contains no Esri static-map substitution", () => {
  const source = readFileSync(new URL("../server/production-imagery.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /arcgis|World_Imagery|server\.arcgisonline/i);
  assert.match(source, /api\.mapbox\.com/, "the static-map primary is Mapbox");
  assert.match(source, /maps\.googleapis\.com\/maps\/api\/staticmap/, "Google remains as the measured fallback");
  assert.match(source, /maps\.googleapis\.com\/maps\/api\/streetview/, "Street View is Google");
  assert.match(source, /incrementDurableUsage\("staticmap", 1\)/);
  assert.match(source, /incrementDurableUsage\("streetview", 1\)/);
});

test("the Owner imagery router owns the image routes before the legacy demo/fallback router", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const imageryMount = server.indexOf("app.use(productionImagery)");
  const legacyMount = server.indexOf("app.use(routes)");
  const parityMount = server.indexOf("app.use(parityRoutes)");
  assert.ok(imageryMount >= 0 && legacyMount > imageryMount,
    "productionImagery must own image routes before the legacy router is reachable");
  assert.ok(parityMount > imageryMount,
    "productionImagery must own image routes before parity-routes is reachable");
});

test("the measured rejection bodies are served verbatim, before any credential check", () => {
  // Measured against the original and reproduced byte-for-byte by the rebuild,
  // headers included: content-type text/plain;charset=UTF-8, content-length
  // 11/9, no cache-control.
  const source = readFileSync(new URL("../server/production-imagery.js", import.meta.url), "utf8");
  assert.match(source, /"text\/plain;charset=UTF-8"/,
    "res.send() would rewrite this as 'text/plain; charset=utf-8'");
  assert.match(source, /const NO_LOCATION = "No location";/);
  assert.match(source, /const NO_POINTS = "No points";/);

  const sv = source.slice(source.indexOf('router.get("/api/streetview"'));
  const locationAt = sv.indexOf("plain(res, NO_LOCATION)");
  const keyAt = sv.indexOf("const key = googleKey()");
  assert.ok(locationAt > 0 && keyAt > 0 && locationAt < keyAt,
    "the location must resolve before the credential is consulted, so 'No location' stays exact");
});

test("a missing credential is reported, never disguised as a missing location", () => {
  const source = readFileSync(new URL("../server/production-imagery.js", import.meta.url), "utf8");
  assert.match(source, /"streetview_unconfigured"/);
  assert.match(source, /"staticmap_unconfigured"/);
  assert.doesNotMatch(source, /if \(!key\) return res\.status\(404\)\.end\(\)/,
    "an empty 404 makes an unset key indistinguishable from an unknown address");
});
