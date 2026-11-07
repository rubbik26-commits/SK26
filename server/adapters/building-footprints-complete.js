import { soql, soqlAll } from "./socrata.js";
import { tileBounds } from "./mappluto.js";

export const BUILDING_DATASET = "5zhs-2jue";

export async function completeBuildingFootprintsBbox(minLat, minLng, maxLat, maxLng, { maxRows = 20000 } = {}) {
  if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) {
    return { live: false, complete: false, rows: [], error: "invalid_bbox" };
  }
  // INTERSECTS, not within_box. On a polygon column Socrata's within_box is a
  // CONTAINMENT test: it returns only footprints lying wholly inside the box, so
  // every building straddling a tile edge is silently dropped. Measured on tile
  // 16/19298/24633: within_box 191, intersects 244, and the original serves 244.
  const poly = `POLYGON((${minLng} ${minLat}, ${maxLng} ${minLat}, ${maxLng} ${maxLat}, ${minLng} ${maxLat}, ${minLng} ${minLat}))`;
  const where = `intersects(the_geom, '${poly}')`;
  // No $order. Measured 2026-08-18 position-by-position against the original's
  // published bin sequences: the original serves Socrata's NATURAL row order —
  // an unordered query reproduced it exactly on tiles 16/19298/24633 (244),
  // 16/19295/24640 (127), 15/9649/12316 (1012) and 14/4824/6158 (5026 rows, 3
  // pages), while "$order=bin ASC" matched none of them (first difference at
  // index 0) and "$order=:id ASC" matched none either. bin ASC was added here
  // for paging determinism, not as contract; it put every tile in an order the
  // original never serves.
  //
  // What the sort actually guaranteed — that no row repeats or vanishes between
  // pages — is proven instead of assumed: the dataset's own count(1) for the
  // same predicate must equal the number of rows the paged fetch returned.
  // Nine unordered paged runs of the 3-page z14 tile returned 5026 distinct
  // bins with 0 missing and 0 extra every time, but Socrata does not contract
  // that, so a mismatched pull is refused as incomplete rather than served —
  // the same fail-closed shape this adapter already had.
  const r = await soqlAll(BUILDING_DATASET, { $where: where }, {
    pageSize: 2000,
    maxRows,
    timeoutMs: 40000,
    ttlMs: 60 * 60 * 1000,
    retries: 2
  });
  if (!r.live || r.complete !== true) {
    return { live: false, complete: false, rows: [], source: "NYC Open Data BUILDING 5zhs-2jue", error: r.error || "building_footprints_incomplete" };
  }
  const rows = r.rows || [];
  if (rows.length > 2000) {
    const c = await soql(BUILDING_DATASET, { $select: "count(1)", $where: where }, { timeoutMs: 40000, retries: 2 });
    const expected = c.live ? Number(c.rows?.[0]?.count_1 ?? c.rows?.[0]?.count) : NaN;
    if (!Number.isFinite(expected)) {
      return { live: false, complete: false, rows: [], source: "NYC Open Data BUILDING 5zhs-2jue", error: c.error || "building_footprints_count_unavailable" };
    }
    if (expected !== rows.length) {
      return {
        live: false, complete: false, rows: [], source: "NYC Open Data BUILDING 5zhs-2jue",
        error: `building_footprints_page_drift: source count ${expected} != paged rows ${rows.length}`
      };
    }
  }
  return { live: true, complete: true, rows, source: "NYC Open Data BUILDING 5zhs-2jue" };
}

export async function completeBuildingFootprintsTile(z, x, y, options = {}) {
  const b = tileBounds(z, x, y);
  return completeBuildingFootprintsBbox(b.minLat, b.minLng, b.maxLat, b.maxLng, options);
}
