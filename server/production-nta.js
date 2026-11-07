// The neighborhood overlay on every map surface.
//
// WHAT THE ORIGINAL ACTUALLY SERVES — measured 2026-08-18 against
// nycremarketintel.com, one bbox at a time, with the live DCP layer fetched
// side by side for the same box:
//
//   bbox                                     original            live DCP layer
//   -74.00,40.74,-73.97,40.76 (midtown)      200 ·   7 features    8
//   -74.03,40.70,-73.90,40.88 (Manhattan)    200 ·  87 (38 MN)     89 (38 MN)
//   -74.05,40.65,-73.85,40.85 (MN+BK)        200 · 143 (36 MN)    143 (36 MN)
//   -74.10,40.55,-73.70,40.90 (4 boroughs)   200 · 160 (12 MN)    251 (38 MN)
//   -74.26,40.49,-73.68,40.92 (citywide)     200 · 160 ( 1 MN)    262 (38 MN)
//   (no bbox at all)                         400
//
// Two facts follow, and they overturn the reading this route was unmounted on
// (commit c7a09d4, "keep full current NTA geometry server-side only"):
//
//  1. The original serves the CURRENT DCP 2020 layer, not a packaged snapshot.
//     For every box under the cap its answer is feature-for-feature the live
//     layer — including "Midtown South-Flatiron-Union Square", the polygon the
//     2026-08-17 sweep concluded crashes the compiled bundle's map-control
//     stack. Its geometry on the original is byte-identical to 9nt8-h7nd's
//     (MultiPolygon, 2935 characters of JSON, boro "Manhattan"), and the
//     original's own copy of this bundle renders it.
//  2. The original caps the response at 160 features. That is the whole reason
//     server/data/nta-polys.json holds 160 with a single Manhattan NTA: it is a
//     capture of the original's CITYWIDE answer, i.e. the truncated tail of a
//     citywide query — not the dataset the original draws from.
//
// So the previous conclusion ("the packaged file IS the contract") described
// the one bbox nobody uses. Meanwhile the guard in production-live-guard.js
// answers /api/nta-polys 503 for every request that reaches it, and this router
// was not mounted, so production served NO overlay at all — measured on
// lucia-ru5s.onrender.com: 503 for the citywide box and for a real viewport box
// alike, where the original answers 200 with 160 and 25 features.
//
// The cap is reproduced here. It is also the safety property the earlier revert
// was reaching for: the bundle is never handed more features than the original
// hands it.
//
// ---------------------------------------------------------------------------
// COMPLETED 2026-08-19. Two things the block above left open are now measured,
// and both were live defects: the bbox path answered every malformed request
// 200, and the capped answer was in the wrong order.
//
// (a) THE 400. Driven against the original one query string at a time:
//
//       query string                              original   rebuild (before)
//       (no bbox at all)                          400        200 · 160
//       ?bbox=                                    400        200 · 160
//       ?bbox=abc                                 400        200 · 160
//       ?bbox=-74.00,40.74,-73.97                 400        200 · 160
//       ?bbox=-74.00,40.74,-73.97,40.76,          400        200 · 160
//       ?bbox=-74.00,40.74,-73.97,40.76,1         400        200 · 160
//       ?bbox=-74.00,40.74,foo,40.76              400        200 · 160
//       ?bbox=Infinity,40.74,-73.97,40.76         400        200 · 160
//       ?bbox=NaN,40.74,-73.97,40.76              400        200 · 160
//       ?BBOX=-74.00,40.74,-73.97,40.76           400        200 · 160
//       ?bbox=-74.00,40.74&bbox=-73.97,40.76      400        200 ·   7
//
//     with the body, exactly: {"error":"Provide ?bbox=w,s,e,n"}. The rebuild's
//     "fall back to the citywide box" default is what turned all eleven into a
//     200, and it is gone. The predicate the original applies is exactly
//     `split(",")` into FOUR parts, each `Number()`-finite — measured on the
//     cases either side of every boundary:
//
//       ?bbox=,,,                       200 · 0    Number("")   === 0
//       ?bbox=%20,%20,%20,%20           200 · 0    Number(" ")  === 0
//       ?bbox=0x10,40.74,-73.97,40.76   200 · 35   Number("0x10") === 16
//       ?bbox=1e2,40.74,-73.97,40.76    200 · 35   Number("1e2")  === 100
//       ?bbox=...&extra=1               200 · 7    other params ignored
//
//     and on a repeated bbox the FIRST value decides, not the last and not the
//     two joined: ?bbox=-74.00,40.74,-73.97,40.76&bbox=1,2,3,4 answers 200 · 7,
//     the first box's own answer.
//
// (b) THE ORDER, AND THEREFORE WHICH 160 SURVIVE THE CAP. The block above said
//     "which 160 the original keeps when a box overflows is not determinable
//     from outside — its citywide 160 is not the head of any ordering the DCP
//     layer publishes". That was wrong, and the reason it looked undeterminable
//     is that the original does not order the layer at all: it asks Socrata the
//     spatial question and serves the rows back in the order the source returns
//     them. Measured 2026-08-19 — the original's whole response body, compared
//     with `JSON.stringify(original) === JSON.stringify(socrata)` against
//
//       9nt8-h7nd.json?$select=ntaname,boroname,the_geom
//                     &$where=intersects(the_geom,'POLYGON((w s, e s, e n, w n, w s))')
//                     &$limit=160
//
//     mapped {name: ntaname, boro: boroname, geom: the_geom} — is IDENTICAL,
//     geometry included, on 13 of 13 bboxes: midtown 7, downtown 25, Manhattan
//     87, MN+BK 143, four-borough 160, upper Manhattan 10, Williamsburg 14,
//     LIC 12, South Bronx 20, St. George 10, a reversed box 7, a zero-area
//     point 1, and a box outside the city 0.
//
//     The order this reproduces is NOT sorted — the citywide 160 runs BK0502…
//     BK5693, QN1001…QN8492, SI0101…SI9593, BK0471, BK0501, QN0904, QN1371,
//     BK0101…BK0571, BX0101…BX2891, MN0101 — which is why sorting by
//     (boroname, nta2020) and slicing produced 160 features with a completely
//     different membership: 50 Bronx / 69 Brooklyn / 38 Manhattan / 3 Queens,
//     where the original serves 69 Brooklyn / 49 Bronx / 23 Staten Island /
//     18 Queens / 1 Manhattan. The same natural-row-order finding is recorded
//     for the BUILDING dataset in adapters/building-footprints-complete.js.
//
//     Independent corroboration that this is the original's cap and not a
//     coincidence: the last feature of the reproduced citywide answer is
//     MN0101 "Financial District-Battery Park City", which is exactly the one
//     Manhattan NTA in the long-captured server/data/nta-polys.json.
//
//     A reversed box needs no normalization and gets none: the original feeds
//     w,s,e,n straight into the polygon, so ?bbox=-73.97,40.76,-74.00,40.74
//     describes the same rectangle wound the other way and answers with the
//     same 7 features — measured on the original, and reproduced here.
import { Router } from "express";
import { postgisConfigured, pgNtaPolys } from "./adapters/postgis.js";
import { ntasInBbox, NTA_DATASET } from "./adapters/nta.js";
import { soql } from "./adapters/socrata.js";

const router = Router();

// Measured ceiling on the original's response, see above. Which 160 the
// original keeps when a box overflows is settled by (b): it is the first 160
// rows the source returns for the spatial predicate, so the cap is expressed to
// Socrata as $limit and re-applied to the rows for the same reason the earlier
// implementation applied it — nothing downstream may ever be handed more
// features than the original hands it.
const ORIGINAL_FEATURE_CAP = 160;

// The original's 400. Body measured character for character; it is the only key
// the response carries.
const BBOX_REQUIRED = { error: "Provide ?bbox=w,s,e,n" };

router.get("/api/nta-polys", async (req, res) => {
  // A repeated ?bbox= arrives as an array under Express's query parser. The
  // original answers with the FIRST value's own result (measured above), so the
  // first value is what is read — never the array joined, which would turn two
  // half-boxes into one valid-looking box.
  const rawBbox = Array.isArray(req.query.bbox) ? req.query.bbox[0] : req.query.bbox;
  const parts = String(rawBbox ?? "").split(",");
  const nums = parts.map(Number);
  if (parts.length !== 4 || !nums.every(Number.isFinite)) {
    return res.status(400).json(BBOX_REQUIRED);
  }
  const [west, south, east, north] = nums;

  // Preserve current production precedence as a PREFLIGHT that no longer
  // publishes. A certified PostGIS NTA ingest still answers this query, so the
  // store and its ACL keep being exercised on the production path, but its rows
  // are not what goes on the wire: the original's response is byte-identical to
  // the Socrata spatial query below, ordering and cap membership included, and
  // whether the RPC reproduces THAT order is not measurable from here — the RPC
  // is not configured on this deployment, measured 2026-08-19 by logging the
  // predicate itself from inside this handler and driving one request through
  // the gate: "[nta-probe-5645] postgisConfigured()= false" (the log line was
  // then removed). Publishing an unverified ordering under the original's own
  // cap is how the citywide answer lost 49 of its 69 Brooklyn NTAs in the first
  // place. Nothing is removed; it is computed and withheld, the same way
  // server/market-report.js withholds STOCK_UNAVAILABLE.
  if (postgisConfigured()) {
    await pgNtaPolys(west, south, east, north).catch((e) => {
      console.warn("[nta-polys] PostGIS preflight failed (not published either way):", e?.message);
      return null;
    });
  }

  // Winding is deliberately NOT normalized — see (a)/(b) above; w,s,e,n go in
  // as given, exactly as the original passes them, which is what makes a
  // reversed box answer with the same rectangle's features.
  const polygon = `POLYGON((${west} ${south}, ${east} ${south}, ${east} ${north}, ${west} ${north}, ${west} ${south}))`;
  // No $order. The original serves the source's own row order for this
  // predicate; any $order at all changes which features survive $limit.
  const spatial = await soql(NTA_DATASET, {
    $select: "ntaname,boroname,the_geom",
    $where: `intersects(the_geom, '${polygon}')`,
    $limit: ORIGINAL_FEATURE_CAP
  }, { timeoutMs: 40000, ttlMs: 60 * 60 * 1000, retries: 2 });

  if (!spatial.live) {
    // Say WHICH half failed rather than reporting one generic outage: ask the
    // layer adapter — the client-side intersection path — the same question, so
    // "the DCP layer is down" and "the layer answered but its spatial predicate
    // did not" are distinguishable in the log and in the body. ntasInBbox's
    // features are never published: its (boroname, nta2020) ordering is the one
    // measured NOT to be the original's.
    const layer = await ntasInBbox(west, south, east, north)
      .catch((e) => ({ live: false, features: [], error: e?.message }));
    return res.status(503).json({
      provenance: "unavailable",
      error: "nta_source_unavailable",
      message: layer.live
        ? `The NYC DCP NTA layer is reachable but its bbox query did not return a usable live result (${spatial.error || "unknown"}). The partial packaged snapshot is not used as a production fallback.`
        : `The current NYC DCP NTA layer is unavailable (${layer.error || spatial.error || "unknown"}). The partial packaged snapshot is not used as a production fallback.`
    });
  }

  // Exact success contract from the original scaffold and compiled client:
  // one object containing only the features collection, each feature carrying
  // name, boro and geom in that order and nothing else.
  return res.json({
    features: spatial.rows.slice(0, ORIGINAL_FEATURE_CAP)
      .map((r) => ({ name: r.ntaname, boro: r.boroname, geom: r.the_geom }))
  });
});

export default router;
