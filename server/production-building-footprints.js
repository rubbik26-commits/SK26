// Building footprints: the 3D City extrusion tiles and the dossier's
// "buildings around this point" overlay.
//
// This module is the handler production serves for both paths — it is mounted
// at server.js:129, ahead of production-lot-tile-source-guard, bundleRoutes,
// production-live-extra, parity-routes and routes, each of which also declares
// /api/bldg-tiles and /api/footprints and is therefore shadowed. Mount order
// decides; the route table does not.
//
// Both envelopes below are transcriptions of what https://nycremarketintel.com
// serves, measured 2026-08-18. Every constant carries the measurement that
// fixed it.
import { Router } from "express";
import { buildingFootprintFeature, tileBounds } from "./adapters/mappluto.js";
import { BUILDING_DATASET, completeBuildingFootprintsBbox, completeBuildingFootprintsTile } from "./adapters/building-footprints-complete.js";
// /api/footprints issues its own predicate (within_circle, below), which the
// bbox adapter cannot express, so the shared Socrata core is used directly.
import { soql, soqlAll } from "./adapters/socrata.js";

// strict: true — Express's default non-strict routing also matches a trailing
// slash, and the original does not: GET /api/footprints/ answers 404
// {"error":"Not found"} on nycremarketintel.com while the rebuild answered this
// module's 400. Measured 2026-08-20. The tile paths are unaffected: the
// prefix route registered below still claims /api/bldg-tiles/... with or
// without a trailing slash, which is what the original does there.
const router = Router({ strict: true });

// The original answers {"type":"FeatureCollection","features":[],"note":"zoom in"}
// below zoom 14 and a populated tile at 14 and above. Measured on the original:
//   z12 1206/1539  -> keys [type,features,note]      note "zoom in"
//   z13 2412/3079  -> keys [type,features,note]      note "zoom in"
//   z14 4824/6158  -> keys [type,tile,count,features] count 5026
//   z15 9649/12316 -> keys [type,tile,count,features] count 1012
const MIN_ZOOM = 14;

// There is a ceiling as well as a floor. Measured 2026-08-20 on the original,
// sweeping z with x=0/y=0 so only the zoom gate can decide:
//   z  -1  0  1  12  13 -> {"type":"FeatureCollection","features":[],"note":"zoom in"}
//   z  14 15 16 17 18 19 20 21 -> {"type":...,"tile":{z,x,y},"count":0,"features":[]}
//   z  22 23 25 30 -> {"type":"FeatureCollection","features":[],"note":"zoom in"}
// The rebuild had no ceiling: /api/bldg-tiles/22/0/0 answered with a tile
// envelope where the original answers "zoom in", and /api/bldg-tiles/30/... ran
// a Socrata query for a tile 0.0000003 degrees wide.
const MAX_ZOOM = 21;

// The original rounds bldg-tile geometry to six decimal places (~0.11 m at this
// latitude); /api/footprints does not round at all. Measured on tile
// 16/19298/24633 feature 0 (bin 1015553): the original publishes
// [-73.992886,40.741978] where 5zhs-2jue holds [-73.992886045488,40.741978470648],
// while /api/footprints?lat=40.7549&lng=-73.9840 publishes 11-12 decimals.
const TILE_COORD_DP = 6;

// The original serves at most 6000 features per tile. Measured 2026-08-20 on
// the original, against 5zhs-2jue's own count(1) for the same tile envelope:
//   tile             rows in tile   original count   rebuild count (before)
//   14/4826/6161          8281            6000            8281
//   14/4827/6161            —             6000              —
//   14/4823/6164            —             6000              —
//   14/4825/6164            —             6000              —
//   14/4829/6157            —             6000              —
//   14/4824/6164            —             6000              —
//   14/4827/6156            —             5756            5756   (under the cap)
//   14/4818/6168            —             5045            5045   (under the cap)
//   14/4820/6164            —             4002            4002   (under the cap)
// Never above 6000 at any probed tile; every tile below it is served whole, so
// this is a cap and not a coincidence of tile size.
//
// It is the first 6000 rows of Socrata's natural order, not a distance or area
// ranking. Measured on 14/4826/6161: a single $limit=6000 request and a paged
// 3 x 2000 pull both reproduce the original's 6000 bins in the original's exact
// published order (orderEq true for both).
//
// The cap is served the way the original serves it: ONE request carrying
// $limit=6000, not an exhausting paged pull that is then sliced. The two are
// not interchangeable, because Socrata's row order for an unordered query is
// per-request. Measured on 14/4832/6161, the densest z14 tile in the city
// (12,869 rows, found by scanning all 408 z14 tiles covering NYC):
//   form                                      matches the original
//   single request $limit=6000                SET 4/4 runs, ORDER 3/4 runs
//   paged 2000-at-a-time, first 6000 sliced   SET 0/3 runs, ORDER 0/3 runs
// The sliced paged pull does not merely reorder the same 6000 buildings — it
// publishes a different 6000, because $offset walks an order the server is free
// to re-roll between pages. Three paged pulls of that tile also returned 12,869
// rows holding only 12,863 distinct bins on one run (6 rows duplicated, 6
// dropped), which the adapter's count(1) guard cannot see: the totals agree.
// One request has no offsets and therefore no drift to guard against, and
// soqlAll treats an explicit caller $limit as complete by contract
// (server/adapters/socrata.js:230), so the completeness check below is kept and
// still fails closed on an upstream error.
//
// completeBuildingFootprintsTile is retained above and still imported; it
// cannot express this query (it hardcodes pageSize 2000 and omits $limit), so
// the predicate is built here from the same tileBounds the adapter uses.
const TILE_ROW_LIMIT = 6000;

// SUPERSEDED 2026-08-20 — kept, with its measurements, as the record of what
// was ruled out before the selector was recovered. FOOTPRINT_DLNG and
// FOOTPRINT_DLAT are no longer part of the selector; the recovered rule is
// FOOTPRINT_RADIUS_M / FOOTPRINT_LIMIT below. Nothing here is deleted: the
// constants and the negative results they document stay in the file.
//
// The half-widths of the /api/footprints query box, in degrees.
//
// I did not know the exact rule the original uses to choose this set when the
// paragraph below was written. It is
// deterministic (three identical runs) and coordinate-sensitive (a 0.0001 shift
// changes the count), and every BIN it returns exists in 5zhs-2jue, so it is a
// live spatial query against the same dataset the tiles use. But the selection
// is not reproduced by: a centred box under intersects or within_box, a circle
// of any radius, a nearest-N prefix, the z16-z19 tile containing the point, a
// join against MapPLUTO lots (contains or intersects), a join against the BBLs
// /api/nearby returns, or any single-column filter on feature_code,
// last_status_type, geom_source, height_roof, construction_year,
// ground_elevation, shape_area, doitt_id or last_edited_date. In Midtown it
// omits a building 24 m from the point while returning one 120 m away.
//
// What is measured is the floor: 0.0016 x 0.0012 is the smallest box that omits
// nothing the original serves at any probed point.
//   probe            original  box 0.0015/0.0011   box 0.0016/0.0012
//   Midtown  9   25 (0 missing)   32 (0 missing)
//   LIC     33   47 (0 missing)   53 (0 missing)
//   BedStuy 168  207 (1 MISSING)  242 (0 missing)
//   FiDi     3   14 (0 missing)   18 (0 missing)
//   SouthBronx 0  9 (0 missing)    9 (0 missing)
// So this returns a superset: every footprint the original draws, plus ones it
// does not. The client (index-BbnE3o5g.js) draws the collection on a Leaflet map
// pinned to zoom 19 with no distance filter, so the extra polygons fall outside
// the visible viewport. Narrowing further would start dropping buildings the
// original shows, which is the worse error.
const FOOTPRINT_DLNG = 0.0016;
const FOOTPRINT_DLAT = 0.0012;

// The recovered /api/footprints selector, measured 2026-08-20.
//
//   $where = within_circle(the_geom, <lat>, <lng>, 140)
//   $limit = 200
//   no $order
//
// Two things had been missed. The first is that on a POLYGON column Socrata's
// within_* predicates are CONTAINMENT tests, not intersection tests: a footprint
// is returned only when the whole polygon lies inside the shape. That is why the
// earlier box work could never converge — it was comparing an intersects()
// superset against a contains() answer, so the original looked like it was
// "omitting a building 24 m from the point while returning one 120 m away". It
// was not: the 24 m building (bin 1087268, 140 m across) is not wholly inside
// the circle, and the 120 m one (bin 1091074, 6 m across) is. The second is that
// the shape is a circle, not a box; a box of any half-widths contradicts the
// original at 8 of the 15 probed points, a circle contradicts it at none.
//
// The radius is 140 m exactly. Counts from 5zhs-2jue's own count(1) under
// within_circle at each radius, against the original's published count:
//   point                        original  R=135  R=138  R=139  R=139.5  R=140  R=141  R=145  R=150
//   40.7549,-73.9840 Midtown            9      9      9      9        9      9     10     10     11
//   40.6870,-73.9410 Bed-Stuy          94     87     92     93       93     94     95    101    113
//   40.7590,-73.8300 Flushing          74     73     74     74       74     74     76     82     90
//   40.7484,-73.9857 Empire State      30     27     29     30       30     30     30     34     40
// 140 is the only radius that reproduces all four; 139.5 is one short at
// Bed-Stuy and 141 is one over at Midtown.
//
// The cap is 200 rows. Brooklyn 40.6710,-73.9814 (Park Slope) holds 207
// footprints wholly inside the 140 m circle and the original publishes 200 of
// them — the first 200 of Socrata's natural order, matched bin-for-bin and
// position-for-position. No other probed point reaches the cap.
//
// Verified across all five boroughs — a tower, a rowhouse block, a campus, two
// vacant points, a condo, a corner lot and a waterfront lot. Original count vs
// this query's, with a full content comparison of every feature (bbl, bin, key
// order and every geometry coordinate):
//   Midtown-BryantPark  9/9    Midtown-ESB-tower 30/30   FiDi            14/14
//   UWS-rowhouse       66/66   CentralPark-vacant 0/0    BK-BedStuy      94/94
//   BK-ParkSlope     200/200   BK-NavyYard        8/8    QN-LIC          33/33
//   QN-Flushing        74/74   BX-SouthBronx     86/86   BX-Fordham       6/6
//   SI-StGeorge        12/12   SI-suburban        0/0    BPC-condo        6/6
// 15 of 15 identical, 0 missing, 0 extra, 0 content mismatches.
//
// No $order. Feature order is Socrata's natural order for this predicate, and
// it is not stable on either side: three back-to-back requests to the ORIGINAL
// returned three different orders at 40.7870,-73.9754, 40.7590,-73.8300 and
// 40.8620,-73.8850 (same 66 / 74 / 6 bins each time). Paired runs of the
// original and this query agree; adding an $order would pin an order the
// original never guarantees and does not itself serve twice in a row.
const FOOTPRINT_RADIUS_M = 140;
const FOOTPRINT_LIMIT = 200;

// Math.round(v * 10**dp) / 10**dp, not Number(v.toFixed(dp)). The two agree on
// every coordinate except an exact half at the (dp+1)th decimal, where toFixed
// rounds away from zero and Math.round rounds toward +Infinity — and every NYC
// longitude is negative, so a tie moves the published value by 1e-6 in the
// direction the original does not take. Measured 2026-08-20 by rounding the
// live 5zhs-2jue row for every feature the original publishes, under both
// rules, and comparing to what the original actually published:
//   428,094 features compared across 44 tiles at z14/z15/z16 in all five boroughs
//   the two rules disagree on   3 features
//     15/9645/12330 bin 3151237  raw -74.0308205  original -74.03082   toFixed -74.030821
//     14/4830/6152  bin 2093069  original matches Math.round
//     14/4833/6162  bin 4619542  original matches Math.round
//   original == Math.round(v*1e6)/1e6 : 3
//   original == Number(v.toFixed(6))  : 0
//   original == neither               : 0
// No counter-example. /api/footprints is unaffected: it does not round at all.
const roundCoords = (value, dp) => {
  if (typeof value === "number") return Math.round(value * 10 ** dp) / 10 ** dp;
  if (Array.isArray(value)) return value.map((v) => roundCoords(v, dp));
  return value;
};



router.get("/api/bldg-tiles/:z/:x/:y", bldgTileHandler);
// The original's tile route is prefix-shaped, not a strict three-segment match.
// Measured 2026-08-20 — the original against the rebuild before this line:
//   path                                    original                      rebuild
//   /api/bldg-tiles                         404 {"error":"Not found"}     404 {"error":"Not found"}
//   /api/bldg-tiles/                        400 {"error":"z/x/y required"} 503 live_source_unavailable
//   /api/bldg-tiles/16                      400 z/x/y required             503 live_source_unavailable
//   /api/bldg-tiles/16/19298                400 z/x/y required             503 live_source_unavailable
//   /api/bldg-tiles/16//24633               400 z/x/y required             503 live_source_unavailable
//   /api/bldg-tiles///                      400 z/x/y required             503 live_source_unavailable
//   /api/bldg-tiles/16/19298/24633/extra    200 tile 16/19298/24633 n=244  503 live_source_unavailable
//   /api/bldg-tiles/16/19298/24633/extra/more 200 same tile, n=244         503 live_source_unavailable
// Express's :param matches [^/]+?, so an empty or missing segment never reached
// the handler at all; the request fell past every owner to the live guard in
// server/production-live-guard.js:65, which answers 503 for any guarded path no
// route claimed. The original answers those from the tile handler itself, on the
// first three segments after the prefix, ignoring anything after them — which is
// what reading seg[3..5] above already does. "/api/bldg-tiles" with no trailing
// slash is NOT matched by this pattern and stays the 404 the original serves.
// The strict route above is kept and still matches first; this only claims the
// shapes it cannot express.
router.get("/api/bldg-tiles/*", bldgTileHandler);

// bldgTileHandler is a hoisted function declaration so both registrations
// above can name it before it appears in the file.
async function bldgTileHandler(req, res) {
  // The original parses the RAW, un-decoded path segment with parseInt(v, 10).
  // The rebuild used Number(req.params.v) — Express decodes route params, and
  // Number() is not parseInt(). Measured 2026-08-20 against the original:
  //   path segment      original                    rebuild (before)
  //   /16/abc/24633     400 {"error":"z/x/y required"}  400 {"error":"invalid_tile"}
  //   /16.5/19298/24633 200 tile z16                 400 invalid_tile
  //   /16/1e3/24633     200 tile x=1                 200 tile x=1000
  //   /16/0x10/24633    200 tile x=0                 200 tile x=16
  //   /16/19298abc/…    200 tile x=19298             400 invalid_tile
  //   /16/019298/24633  200 tile x=19298             200 tile x=19298
  //   /16/+19298/24633  200 tile x=19298             200 tile x=19298
  //   /16/-0/24633      200 tile x=0                 200 tile x=0
  //   /16/19298%20/…    200 tile x=19298 count=244   200 count=244
  //   /16/%2019298/…    400 z/x/y required           200 count=244
  //   /16/%2b19298/…    400 z/x/y required           200 count=244
  //   /16/1%39298/…     200 tile x=1                 200 tile x=19298
  //   /16/.5/24633      400 z/x/y required           400 invalid_tile
  // The last four separate the two readings: %2b decodes to "+" and %20 to a
  // leading space, both of which parseInt would accept, and 1%39298 decodes to
  // "19298" but is 1 when read raw. The original answers as if it never
  // decoded, so the raw segments are recovered from req.originalUrl. Segment
  // indices are fixed: this router is mounted at the app root (server.js:129)
  // and the path is absolute, so ["", "api", "bldg-tiles", z, x, y]. A trailing
  // slash leaves a 7th empty segment and does not move them — the original
  // serves /16/19298/24633/ as tile 16/19298/24633, count 244, and so does this.
  const seg = String(req.originalUrl || req.url).split("?")[0].split("/");
  const z = Number.parseInt(seg[3], 10), x = Number.parseInt(seg[4], 10), y = Number.parseInt(seg[5], 10);
  // The original's rejection body for an unparseable segment, measured:
  // 400 {"error":"z/x/y required"}. The rebuild answered {"error":"invalid_tile"}.
  if (![z, x, y].every(Number.isInteger)) return res.status(400).json({ error: "z/x/y required" });
  if (z < MIN_ZOOM || z > MAX_ZOOM) {
    // The 2026-08-18 note below — cache-control: public, max-age=604800,
    // stale-while-revalidate=2592000 — was measured on the TILE branch, and it
    // is still set there. It does not hold here. Measured 2026-08-20, response
    // headers on the zoom-gate branch:
    //   original GET /api/bldg-tiles/12/1206/1539 -> cache-control ABSENT
    //   original GET /api/bldg-tiles/13/2412/3079 -> cache-control ABSENT
    //   original GET /api/bldg-tiles/22/0/0       -> cache-control ABSENT
    //   original GET /api/bldg-tiles/16/19298/24633 -> cache-control present
    // The rebuild was sending the week-long cache header on the empty
    // "zoom in" answer too, which the original never does, so the header is no
    // longer set on this branch. The body was already identical.
    return res.json({ type: "FeatureCollection", features: [], note: "zoom in" });
  }
  // x and y must address a tile that exists at this zoom. Measured on the
  // original — the check runs after the zoom gate, never before it:
  //   16/65535/24633 -> 200 tile      16/65536/24633 -> 400 {"error":"tile out of range"}
  //   14/16383/6158  -> 200 tile      14/16384/6158  -> 400 tile out of range
  //   19/524287/0    -> 200 tile      19/524288/0    -> 400 tile out of range
  //   21/2097151/…   -> 200 tile      21/2097152/0   -> 400 tile out of range
  //   16/24633/-1    -> 400 tile out of range
  //   1/2/0 and 13/8192/8192 -> "zoom in", not 400: both are out of range for
  //   their zoom, so the zoom gate above is what answers them.
  // The rebuild had no range check: 16/-5/24633 and 16/999999/24633 both
  // answered 200 with a tile envelope and count 0.
  const tilesPerAxis = 2 ** z;
  if (x < 0 || x >= tilesPerAxis || y < 0 || y >= tilesPerAxis) {
    return res.status(400).json({ error: "tile out of range" });
  }
  const b = tileBounds(z, x, y);
  const poly = `POLYGON((${b.minLng} ${b.minLat}, ${b.maxLng} ${b.minLat}, ${b.maxLng} ${b.maxLat}, ${b.minLng} ${b.maxLat}, ${b.minLng} ${b.minLat}))`;
  const r = await soqlAll(BUILDING_DATASET, {
    $where: `intersects(the_geom, '${poly}')`,
    $limit: String(TILE_ROW_LIMIT)
  }, {
    pageSize: TILE_ROW_LIMIT,
    maxRows: TILE_ROW_LIMIT,
    timeoutMs: 40000,
    ttlMs: 60 * 60 * 1000,
    retries: 2
  });
  if (!r.live || r.complete !== true) {
    return res.status(503).json({ provenance: "unavailable", error: "building_footprints_incomplete", message: r.error || "Building footprint tile could not be exhausted." });
  }
  // Exactly the four properties the original publishes. Measured across all 244
  // features of tile 16/19298/24633, all 127 of 16/19295/24640 and all 1012 of
  // 15/9649/12316: the union of property keys is {bbl,h,yr,bin} and nothing
  // else. heightRoofFt/provenance/source, which buildingFootprintFeature also
  // carries for the other consumers of that helper, are dropped here.
  const features = [];
  for (const row of r.rows) {
    const f = buildingFootprintFeature(row);
    if (!f.geometry) continue;
    features.push({
      type: "Feature",
      geometry: { ...f.geometry, coordinates: roundCoords(f.geometry.coordinates, TILE_COORD_DP) },
      // h and yr pass through unchanged, null included. The original publishes
      // yr:null for the 3 features of tile 16/19298/24633 whose 5zhs-2jue row
      // carries no construction_year (bins 1015492, 1016254, 1084663) — not 0.
      // A zero there would read as "built in year zero"; null reads as unknown,
      // which is what the record says.
      properties: {
        bbl: f.properties.bbl,
        h: f.properties.h,
        yr: f.properties.yr,
        bin: f.properties.bin
      }
    });
  }
  // The original's own header on this route, measured 2026-08-18:
  // cache-control: public, max-age=604800, stale-while-revalidate=2592000.
  // The rebuild was serving max-age=3600 / swr=86400 — a 168x shorter browser
  // cache on tiles whose source data changes on DOB's publication cadence.
  res.set("cache-control", "public, max-age=604800, stale-while-revalidate=2592000");
  // The populated-tile branch is the ONE branch in this family the original
  // serves as bare "application/json", with no charset parameter. Measured
  // 2026-08-20 with accept-encoding: identity, original vs rebuild before this
  // change:
  //   path                          original content-type            rebuild
  //   14/4824/6158  count 5026      application/json                 application/json; charset=utf-8
  //   14/4826/6161  count 6000      application/json                 application/json; charset=utf-8
  //   15/9649/12316 count 1012      application/json                 application/json; charset=utf-8
  //   15/9645/12330 count 2966      application/json                 application/json; charset=utf-8
  //   16/19298/24633 count 244      application/json                 application/json; charset=utf-8
  //   16/19295/24640 count 127      application/json                 application/json; charset=utf-8
  //   16/19334/24618 count 9        application/json                 application/json; charset=utf-8
  //   17/38596/49266 count 75       application/json                 application/json; charset=utf-8
  //   14/0/0         count 0        application/json                 application/json; charset=utf-8
  //   21/0/0         count 0        application/json                 application/json; charset=utf-8
  //   13/2412/3079   "zoom in"      application/json; charset=utf-8  (same)
  //   22/0/0         "zoom in"      application/json; charset=utf-8  (same)
  //   /api/footprints 200 and 400   application/json; charset=utf-8  (same)
  // A count of 0 does not move it, so it is the branch and not the payload.
  //
  // res.json() cannot express this. Express 4's res.json falls through to
  // res.send(), and res.send() with a STRING body runs
  // setCharset(type, 'utf-8') over whatever content-type is already set
  // (node_modules/express/lib/response.js, express 4.22.2), so the charset
  // comes back no matter how the header was written beforehand —
  // res.set("content-type", "application/json") also appends it by itself, via
  // mime.charsets.lookup.
  //
  // The body is therefore handed to res.send() as a BUFFER. res.send guards
  // that whole setCharset block with `typeof chunk === 'string'`, so a Buffer
  // walks past it and the header stays exactly as written here, while
  // res.send still derives content-length (identity request, 16/19295/24640 ->
  // content-length 54308 on both sides) and still lets compression negotiate
  // (br on both sides; the decoded bodies are byte-identical).
  //
  // res.end(body) also produces the bare content-type, and was tried first. It
  // is not usable: compression() replaces res.end with its own wrapper, and
  // when it compresses it hands the body to a zlib stream and calls the real
  // end from a zlib callback. scripts/route-probe.mjs patches
  // express.response's methods to record the stack frame that committed the
  // response, and by the time that deferred call runs there is no repo frame
  // left on the stack. Measured: tests/route-resolution.test.mjs failed with
  //   /api/bldg-tiles/16/19298/24633?v=2 was answered by unresolved
  // — a false negative in the gate that exists to catch route shadowing.
  // res.send() is called synchronously from this frame and keeps it truthful.
  const body = Buffer.from(JSON.stringify({
    type: "FeatureCollection",
    tile: { z, x, y },
    count: features.length,
    features
  }));
  res.setHeader("content-type", "application/json");
  return res.send(body);
}

// The trailing-slash form is not this route's: the router above is strict.
// Measured 2026-08-20:
//   original GET /api/footprints/   -> 404 {"error":"Not found"}
//   original GET /api/footprints/x  -> 404 {"error":"Not found"}
//   rebuild  GET /api/footprints/   -> 400 {"error":"Provide ?lat= & ?lng="}  (before)
router.get("/api/footprints", async (req, res) => {
  // parseFloat over the RAW query string, not Number(req.query.v).
  //
  // Two separate defects. Number("") is 0, so ?lat=&lng= was answered as the
  // point 0,0 instead of rejected; and this app sets Express's extended (qs)
  // query parser, which turns ?lat[]=40.7549 into req.query.lat = ["40.7549"]
  // while Number(["40.7549"]) is 40.7549 — the original has no such key and
  // rejects. Reading the raw query with URLSearchParams reproduces the original
  // independently of whichever query parser the app is configured with.
  // Measured 2026-08-20, original vs rebuild before this change:
  //   query                              original                 rebuild
  //   lat=&lng=                          400 Provide ?lat= & ?lng=  200 {"lat":0,"lng":0,…}
  //   lat[]=40.7549&lng=-73.98           400 Provide ?lat= & ?lng=  200 lat=40.7549
  //   lat=40.7549&lat=40.68&lng=-73.984  200 lat=40.7549 (first)    400 Provide…
  //   lng=-73.9840'                      200 lng=-73.984            400 Provide…
  //   lat=40.7549abc                     200 lat=40.7549            400 Provide…
  //   lat=.5                             200 lat=0.5                200 lat=0.5
  //   lat=0x28                           200 lat=0                  200 lat=0
  //   lat=%2040.7549 / %2b40.7549        200 lat=40.7549            200 lat=40.7549
  //   lat=40,7549                        200 lat=40                 400 Provide…
  //   lat=Infinity / NaN / 1e400         400 Provide ?lat= & ?lng=   400 Provide…
  //   lat=91&lng=200                     200 lat=91 lng=200         200 (no range check)
  //   LAT=40.7549&LNG=-73.9840           400 Provide ?lat= & ?lng=   400 Provide…
  // Unlike the tile path segments above, the query string IS decoded: the
  // original reads %2040.7549 as " 40.7549" and answers 40.7549.
  const query = new URLSearchParams(String(req.originalUrl || req.url).split("?").slice(1).join("?"));
  const lat = Number.parseFloat(query.get("lat")), lng = Number.parseFloat(query.get("lng"));
  // The original's rejection body, measured: GET /api/footprints and
  // /api/footprints?lat=abc&lng=-73.98 both answer 400 {"error":"Provide ?lat= & ?lng="}.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "Provide ?lat= & ?lng=" });
  // The predicate is issued here rather than through completeBuildingFootprintsBbox
  // because the natural row order Socrata returns depends on the WHERE clause:
  // at Park Slope the bbox-intersects superset and the within_circle answer
  // disagree on order from index 2 onward even though the circle's 200 rows are
  // a subset of the box's. Filtering a box superset down to the circle would
  // reproduce the original's set but not its order, so the original's own
  // predicate is sent instead.
  //
  // There is no paging and therefore no exhaustion to verify: $limit=200 is the
  // original's published contract (see FOOTPRINT_LIMIT above), not a truncation
  // this rebuild is choosing, so the adapter's page-drift guard has nothing to
  // guard here. An upstream failure still fails closed below.
  const r = await soql(BUILDING_DATASET, {
    $where: `within_circle(the_geom, ${lat}, ${lng}, ${FOOTPRINT_RADIUS_M})`,
    $limit: String(FOOTPRINT_LIMIT)
  }, { timeoutMs: 40000, ttlMs: 60 * 60 * 1000, retries: 2 });
  if (!r.live) {
    return res.status(503).json({ provenance: "unavailable", error: "building_footprints_incomplete", message: r.error || "Building footprint viewport could not be exhausted." });
  }
  // {bbl,bin,geom} and nothing else, geometry unrounded — measured on the
  // original at Midtown, LIC, BedStuy and Staten Island: the union of feature
  // keys is exactly those three at every point.
  const features = r.rows
    .map(buildingFootprintFeature)
    .filter((f) => f.geometry && f.properties.bbl)
    .map((f) => ({ bbl: f.properties.bbl, bin: f.properties.bin, geom: f.geometry }));
  return res.json({ lat, lng, features });
});

// GET /api/footprints/ — the single-trailing-slash form — is NOT this family's
// route on the original: it is an unrouted path there, and answers the app's
// generic 404 to every method. The strict router above already declines it, but
// the rebuild still answered from a router mounted BELOW this one, so the path
// had to be claimed here to shadow them.
//
// Measured 2026-08-20, original vs rebuild before this block:
//   method   path                                    original                   rebuild
//   GET      /api/footprints/                        404 {"error":"Not found"}  400 {"error":"invalid_coordinates"}
//   GET      /api/footprints/?lat=40.7549&lng=-73.984 404 {"error":"Not found"}  200 {"features":[…]}  (57154 b, and the
//                                                                                 envelope has no lat/lng at all)
//   POST     /api/footprints/                        404 {"error":"Not found"}  405 {"error":"Method not allowed"}
//   PUT      /api/footprints/                        404 {"error":"Not found"}  405 {"error":"Method not allowed"}
//   PATCH    /api/footprints/                        404 {"error":"Not found"}  405 {"error":"Method not allowed"}
//   DELETE   /api/footprints/                        404 {"error":"Not found"}  405 {"error":"Method not allowed"}
//   OPTIONS  /api/footprints/                        404 {"error":"Not found"}  405 {"error":"Method not allowed"}
//   HEAD     /api/footprints/                        404 (no body)              405 (no body)
// while /api/footprints/x and /api/footprints// already answered 404 on both.
//
// Which router was answering, measured — not read off the route table — by
// importing each mounted module and testing its own route layers' regexps
// against the path at runtime:
//   /api/footprints/  <- production-live-extra   route "/api/footprints"  [get]
//   /api/footprints/  <- parity-routes           route "/api/footprints"  [get]
//   /api/footprints/  <- routes                  route "/api/footprints"  [get]
//   /api/footprints/  <- production-building-footprints : NO MATCH (strict)
// All three build their Router without { strict: true }, so Express's default
// non-strict path-to-regexp appends an optional trailing slash to every route
// and each of them claims /api/footprints/ as well as /api/footprints. The
// first of the three in mount order is server/production-live-extra.js
// (server.js:312), whose 400 body {"error":"invalid_coordinates"} is exactly
// what the rebuild was serving. The root-cause fix belongs in those three
// files — Router({ strict: true }) — and they are not this agent's to edit, so
// the path is claimed here instead, ahead of all of them (server.js:238).
//
// Registered per-method rather than with router.all(): server.js's method guard
// (server.js:145 methodsFor) reads Object.keys(layer.route.methods), and
// route.all() records only the pseudo-method "_all", which the guard would then
// find missing for GET and answer 405 to everything. Naming the methods keeps
// the guard passing every one of them through to this handler, which is what
// produces the original's single 404 for all seven.
//
// The 404 is written with explicit headers rather than res.status(404).json():
// the original's is content-type application/json; charset=utf-8,
// content-length 21, and carries NO cache-control and no etag. res.json()
// would attach an etag, and the app's own generic 404 (server.js:127
// notFoundJson) attaches cache-control: no-store, which the original never
// sends on any 404 — that generic-404 header difference is global to the
// rebuild and is reported separately rather than being spread here.
const footprintsTrailingSlash404 = (_req, res) => {
  const body = JSON.stringify({ error: "Not found" });
  res.status(404);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  return res.end(body);
};
for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
  router[method]("/api/footprints/", footprintsTrailingSlash404);
}

export default router;
