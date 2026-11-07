// Prove a tax-lot tile is complete before it is drawn.
//
// The rule this enforces has not changed: a dense tile must never be returned
// silently clipped, because a half-drawn grid reads as "these are the lots
// here". What changed is the universe it proves.
//
// This used to count the DOF Digital Tax Map and PLUTO, because that is what
// the tile handler read. The handler now reads the City's own MapPLUTO ArcGIS
// service — the source the original names in its own `x-lot-source` header —
// so counting DOF would be proving something about a source no longer served.
// Worse, DOF's condo BASE lots do not join to PLUTO's condo BILLING BBLs, which
// is why the old pair returned 38 blank-attribute lots in a 177-lot Midtown
// tile where the original returns 238 populated ones.
//
// The completeness proof is the service's own count for the tile envelope,
// compared against what the paged fetch is allowed to retrieve. Outside the
// grid's zoom band there is nothing to prove: the handler answers
// {"features":[],"note":"zoom in"}, as the original does.
import { Router } from "express";
import { tileBounds } from "./adapters/mappluto.js";

const router = Router();
const MAPPLUTO_QUERY = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
// The ceiling mapPlutoTileAll pages up to. Kept in step with it by name here
// and by the same number there.
//
// "A tile past it is refused, not truncated" was this constant's stated
// contract. Measured 2026-08-20 against the original, it is not the original's:
// the original TRUNCATES and never refuses. Every z14 tile in the 702-tile
// grid covering the city was counted against the MapPLUTO service, and the
// twelve above 8,000 lots were probed on both sides:
//   14/4827/6161  service count 9190  ->  original 200, count 8000, 8000 features
//   14/4830/6161  service count 8942  ->  original 200, count 8000, 8000 features
//   14/4823/6165  service count 8605  ->  original 200, count 8000, 8000 features
//   14/4824/6165  8577, 14/4827/6165  8498, 14/4828/6160  8489,
//   14/4831/6161  8378, 14/4829/6162  8366, 14/4826/6161  8311,
//   14/4832/6161  8174, 14/4828/6164  8084, 14/4824/6164  8043
//                                       ->  original 200, count 8000, every one
//   14/4829/6159  service count 7919  ->  original 200, count 7919 (uncapped)
//   14/4826/6166  service count 7913  ->  original 200, count 7913 (uncapped)
// The original's 8,000 are the SAME lots in the SAME order as the first 8,000
// the rebuild returns — checked BBL by BBL on all twelve. So the honest answer
// for a tile above the cap is the original's own truncation, published by the
// handler, not a 503 from here.
const HANDLER_LIMIT = 20000;
// The number of features the original publishes for a tile at most, from the
// twelve measurements above. Recorded here because it is the real ceiling the
// count below is worth comparing against; the truncation itself belongs to the
// handler that builds the feature list, not to this proof.
const LOT_TILE_PUBLISHED_CAP = 8000;
const MIN_ZOOM = 14;
// The original serves a tile from a source for z14 through z21 and answers
// z22 and above with the same {"features":[],"note":"zoom in"} it answers
// below z14 — no tile, no source, no count. Measured 2026-08-20 on the
// original, tiles centred on 40.7436,-73.9927:
//   z=19 19/154384/197063  -> 200 source "pluto" count 6
//   z=20 20/308768/394126  -> 200 source "pluto" count 4
//   z=21 21/617537/788252  -> 200 source "pluto" count 3
//   z=22 22/1235074/1576504 -> 200 {"type":"FeatureCollection","features":[],"note":"zoom in"}
//   z=23, z=24, z=25 and 99/1/1 -> the same "zoom in" body
// Without this ceiling the proof below asked MapPLUTO for a tile the original
// never sources. With the count service made unreachable, the rebuild answered
// /api/lot-tiles/25/9880596/12612033 with 503 lot_tile_source_unavailable while
// the original answered 200 "zoom in" — a source outage turned into an error on
// a request the original never touches a source for.
const MAX_ZOOM = 21;
// How the original reads the three path segments. It is parseInt's rule — take
// the leading integer and ignore the rest — not Number's whole-string rule.
// Measured 2026-08-20 on the original:
//   /api/lot-tiles/16/19298abc/24633     -> 200 tile {"z":16,"x":19298,"y":24633} source "pluto" count 238
//   /api/lot-tiles/16/19298/24633.999999 -> 200 tile {"z":16,"x":19298,"y":24633} source "pluto" count 238
//   /api/lot-tiles/16/19298.5/24633      -> 200 tile {"z":16,"x":19298,"y":24633} source "pluto" count 238
//   /api/lot-tiles/1.6e1/19298/24633     -> 200 {"type":"FeatureCollection","features":[],"note":"zoom in"}  (z is 1, not 16)
//   /api/lot-tiles/0x10/19298/24633      -> 200 {"type":"FeatureCollection","features":[],"note":"zoom in"}  (radix 10, so z is 0)
//   /api/lot-tiles/16/1.9298e4/24633     -> 200 tile {"z":16,"x":1,"y":24633} source "nys" count 0
//   /api/lot-tiles/16/%2019298/24633     -> 400 {"error":"z/x/y required"}   (a leading space is not a digit)
//   /api/lot-tiles/16/NaN/24633          -> 400 {"error":"z/x/y required"}
//   /api/lot-tiles/16/Infinity/24633     -> 400 {"error":"z/x/y required"}
//   /api/lot-tiles/16//24633             -> 400 {"error":"z/x/y required"}
// This guard read them with Number(), which disagrees with the original on
// every one of the first five. Measured on the rebuild before this change
// (temporary x-guard-probe header, removed again after the measurement):
//   /api/lot-tiles/16/19298abc/24633 -> guard skipped   the original serves that tile's 238 lots in full
//   /api/lot-tiles/1.6e1/19298/24633 -> guard ran       the original never sources this request at all
// Reading them the original's way puts the proof on exactly the requests the
// original answers from a source. A segment with no leading integer is handed
// straight on: the exact handler owns the 400 body, as it always did.
const leadingInt = (v) => {
  const m = /^-?\d+/.exec(String(v ?? ""));
  return m ? Number(m[0]) : null;
};

router.get("/api/lot-tiles/:z/:x/:y", async (req, res, next) => {
  const z = leadingInt(req.params.z), x = leadingInt(req.params.x), y = leadingInt(req.params.y);
  if (![z, x, y].every(Number.isInteger)) return next(); // exact handler owns 400/error shape
  // Outside z14..z21 the handler answers "zoom in"; there is no tile and so
  // nothing to prove. See MIN_ZOOM / MAX_ZOOM above for the measurement.
  //
  // This stays ahead of the range test below because that is the order the
  // original tests in — an out-of-range x at a zoom outside the band gets the
  // band's answer, not the range refusal. Measured 2026-08-20 on the original:
  //   /api/lot-tiles/13/99999999/1 -> 200 {"type":"FeatureCollection","features":[],"note":"zoom in"}
  //   /api/lot-tiles/22/99999999/1 -> 200 {"type":"FeatureCollection","features":[],"note":"zoom in"}
  //   /api/lot-tiles/25/1/1        -> 200 {"type":"FeatureCollection","features":[],"note":"zoom in"}
  if (z < MIN_ZOOM || z > MAX_ZOOM) return next();
  // A tile outside the pyramid is refused by the original, not served empty, so
  // there is no tile behind it to prove either. Measured 2026-08-20 on the
  // original (2 ** 14 = 16384, 2 ** 16 = 65536):
  //   /api/lot-tiles/14/16384/6158  -> 400 {"error":"tile out of range"}
  //   /api/lot-tiles/14/16383/6158  -> 200 source "nys" count 0
  //   /api/lot-tiles/16/-1/24633    -> 400 {"error":"tile out of range"}
  //   /api/lot-tiles/16/19298/-5    -> 400 {"error":"tile out of range"}
  //   /api/lot-tiles/16/19298/65536 -> 400 {"error":"tile out of range"}
  //   /api/lot-tiles/16/65535/24633 -> 200 source "nys" count 0
  //   /api/lot-tiles/16/-0/24633    -> 200 tile {"z":16,"x":0,"y":24633} source "nys" count 0
  // Without this the guard asked MapPLUTO for the envelope of a tile that does
  // not exist: measured on the rebuild before this change, /api/lot-tiles/16/-1/24633
  // and /api/lot-tiles/16/65536/24633 both ran the count query. The handler owns
  // the 400 body.
  const tiles = 2 ** z;
  if (x < 0 || x >= tiles || y < 0 || y >= tiles) return next();
  const box = tileBounds(z, x, y);

  const params = new URLSearchParams({
    where: "1=1",
    geometry: `${box.minLng},${box.minLat},${box.maxLng},${box.maxLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    // The same predicate the handler fetches with, or the count would prove
    // the wrong thing: contains returns 177 lots for a tile that intersects 238.
    spatialRel: "esriSpatialRelIntersects",
    returnCountOnly: "true",
    f: "json"
  });

  let count = null;
  try {
    const r = await fetch(`${MAPPLUTO_QUERY}?${params}`, {
      signal: AbortSignal.timeout(30000),
      headers: { "user-agent": "nyc-re-market-intel/production" }
    });
    const body = await r.json();
    if (body?.error) throw new Error(body.error.message || "MapPLUTO count failed");
    count = Number(body?.count);
  } catch (e) {
    return res.status(503).json({
      provenance: "unavailable",
      error: "lot_tile_source_unavailable",
      message: "The source count required to prove this tax-lot tile is complete is unavailable. No clipped tile was returned.",
      sources: { mappluto: "unavailable" },
      detail: String(e?.message ?? e).slice(0, 200)
    });
  }

  if (!Number.isFinite(count)) {
    return res.status(503).json({ provenance: "unavailable", error: "lot_tile_count_invalid" });
  }
  // lot_tile_too_dense is NOT published. The measurement recorded at
  // HANDLER_LIMIT above is that the original answers 200 with its first 8,000
  // lots for every tile above the cap — the densest tile in the city, 9,190
  // lots at 14/4827/6161, included — and has no refusal body at any density.
  // A 503 here would be a status the original has never served. Both
  // comparisons stay computed and stay on the request, where the handler that
  // builds the feature list can read them; neither reaches the client.
  req.lotTileSourceCounts = {
    mapPlutoCount: count,
    exceedsHandlerLimit: count > HANDLER_LIMIT,
    exceedsPublishedCap: count > LOT_TILE_PUBLISHED_CAP,
    publishedCap: LOT_TILE_PUBLISHED_CAP
  };
  return next();
});

export default router;
