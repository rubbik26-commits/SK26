// Current NYC Department of City Planning 2020 Neighborhood Tabulation Areas.
// Dataset 9nt8-h7nd is the current DCP layer exposed through NYC Open Data.
// The older packaged reference snapshot is intentionally not a production data
// source because it is incomplete.
import { soql } from "./socrata.js";
import { geometryContains } from "./mappluto.js";

export const NTA_DATASET = "9nt8-h7nd";
const NTA_SELECT = "nta2020,ntaname,boroname,ntatype,the_geom";
const ALL_TTL = 24 * 60 * 60 * 1000;
let allCache = { at: 0, features: null };

function normalizeRow(row) {
  if (!row?.ntaname || !row?.the_geom) return null;
  return {
    code: row.nta2020 ?? null,
    name: String(row.ntaname),
    boro: row.boroname ?? null,
    type: row.ntatype ?? null,
    geom: row.the_geom
  };
}

export async function currentNtas() {
  if (allCache.features && Date.now() - allCache.at < ALL_TTL) {
    return { live: true, features: allCache.features, source: "NYC DCP 2020 NTAs (9nt8-h7nd)", cached: true };
  }
  const r = await soql(NTA_DATASET, {
    $select: NTA_SELECT,
    $limit: 500,
    $order: "boroname,nta2020"
  }, { ttlMs: ALL_TTL, timeoutMs: 60000 });
  if (!r.live) return { live: false, features: [], error: r.error || "nta_unavailable" };
  const features = (r.rows || []).map(normalizeRow).filter(Boolean);
  // DCP currently publishes 262 NTAs. Do not promote a suspiciously small
  // response to citywide authority; that is how the historical partial snapshot
  // became a silent production geography defect.
  if (features.length < 250) {
    return { live: false, features: [], error: `nta_incomplete_${features.length}_rows` };
  }
  allCache = { at: Date.now(), features };
  return { live: true, features, source: "NYC DCP 2020 NTAs (9nt8-h7nd)", cached: false };
}

export async function ntaAt(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { live: false, nta: null, error: "invalid_coordinates" };
  const all = await currentNtas();
  if (!all.live) return { live: false, nta: null, error: all.error };
  const nta = all.features.find((f) => geometryContains(f.geom, lng, lat)) || null;
  return { live: true, nta, source: all.source };
}

function expandBbox(coords, out) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number") {
    const [x, y] = coords;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      out.minLng = Math.min(out.minLng, x); out.maxLng = Math.max(out.maxLng, x);
      out.minLat = Math.min(out.minLat, y); out.maxLat = Math.max(out.maxLat, y);
    }
    return;
  }
  for (const child of coords) expandBbox(child, out);
}

// True polygon-vs-rectangle intersection, replacing the envelope-only test.
//
// The envelope test kept two NTAs the original does not serve for
// bbox=-74.01,40.70,-73.96,40.76 (27 features vs the original's 25). Both are
// pure envelope false positives, measured 2026-08-18:
//   BK0301 Bedford-Stuyvesant (West): its envelope clips a ~140 m x 47 m
//     sliver at the box's SE corner, but every vertex at lat>=40.6995 lies
//     east of the box and every vertex at lng<=-73.9605 lies south of it —
//     the polygon never enters the sliver.
//   MN0191 The Battery-Governors Island-…: 11 separate parts. The union
//     envelope's maxLng comes from one part (Governors Island, lat<=40.69253)
//     and its maxLat from another (The Battery, lng<=-74.01371); no single
//     part reaches both, so the multipart envelope manufactures an overlap no
//     part has.
// With this predicate the rebuild reproduced the original feature-for-feature
// on every non-capped bbox probed: 1/1, 1/1, 25/25, 7/7, 87/87, 143/143, 0/0.
//
// A geometry intersects the rectangle iff any of:
//   (a) a ring vertex lies inside the rectangle,
//   (b) a rectangle corner lies inside the geometry (holes subtracted —
//       geometryContains already implements exactly that), or
//   (c) a ring segment crosses a rectangle edge.
function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy);
  const o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
  return o1 !== o2 && o3 !== o4;
}

function geometryIntersectsBox(geom, minLng2, minLat2, maxLng2, maxLat2) {
  const rings = [];
  const collect = (coords) => {
    if (!Array.isArray(coords)) return;
    if (Array.isArray(coords[0]) && typeof coords[0][0] === "number") { rings.push(coords); return; }
    for (const child of coords) collect(child);
  };
  collect(geom?.coordinates);
  // (a) any vertex inside the rectangle
  for (const ring of rings) {
    for (const p of ring) {
      if (p[0] >= minLng2 && p[0] <= maxLng2 && p[1] >= minLat2 && p[1] <= maxLat2) return true;
    }
  }
  // (b) any rectangle corner inside the geometry
  const corners = [[minLng2, minLat2], [maxLng2, minLat2], [maxLng2, maxLat2], [minLng2, maxLat2]];
  if (corners.some(([x, y]) => geometryContains(geom, x, y))) return true;
  // (c) any ring segment crossing any rectangle edge
  const edges = [
    [minLng2, minLat2, maxLng2, minLat2], [maxLng2, minLat2, maxLng2, maxLat2],
    [maxLng2, maxLat2, minLng2, maxLat2], [minLng2, maxLat2, minLng2, minLat2]
  ];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      for (const [cx, cy, dx, dy] of edges) {
        if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return true;
      }
    }
  }
  return false;
}

export async function ntasInBbox(minLng, minLat, maxLng, maxLat) {
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) {
    return { live: false, features: [], error: "invalid_bbox" };
  }
  const all = await currentNtas();
  if (!all.live) return { live: false, features: [], error: all.error };
  const features = all.features.filter((f) => {
    // Envelope first — a cheap correct superset — then the real intersection,
    // because an envelope alone keeps polygons whose box clips the query while
    // their geometry stays entirely outside it (see geometryIntersectsBox).
    const b = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity };
    expandBbox(f.geom?.coordinates, b);
    if (!(b.minLng <= maxLng && b.maxLng >= minLng && b.minLat <= maxLat && b.maxLat >= minLat)) return false;
    return geometryIntersectsBox(f.geom, minLng, minLat, maxLng, maxLat);
  });
  return { live: true, features, source: all.source };
}

// The immutable client exposes eighteen authored market-area filters. These are
// a product taxonomy, not government boundaries. The bucket is derived only
// from the current official NTA name containing the parcel. If the NTA is
// outside that authored universe, callers display the official NTA name rather
// than forcing it into a guessed bucket.
export function marketAreaForNta(name, boro = "") {
  const n = String(name || "");
  const b = String(boro || "");
  if (b === "Manhattan") {
    if (/Financial District|Battery Park|The Battery/i.test(n)) return "FiDi / Lower Manhattan";
    if (/Tribeca|SoHo|Little Italy|Hudson Square/i.test(n)) return "Tribeca / SoHo / NoHo";
    if (/Chelsea|Hudson Yards/i.test(n)) return "Chelsea / Hudson Yards";
    if (/Midtown South|Flatiron|Union Square|NoMad/i.test(n)) return "Flatiron / NoMad";
    if (/Midtown-Times Square|Garment/i.test(n)) return "Garment District / Midtown South";
    if (/East Midtown|Turtle Bay|Murray Hill|Kips Bay/i.test(n)) return "Midtown East";
    if (/Upper West Side|Lincoln Square|Manhattan Valley/i.test(n)) return "Upper West Side (below 110)";
    if (/Upper East Side|Lenox Hill|Carnegie Hill|Yorkville/i.test(n)) return "Upper East Side (below 96)";
  }
  if (b === "Brooklyn") {
    if (/Carroll Gardens|Cobble Hill|Gowanus|Red Hook|Park Slope/i.test(n)) return "Gowanus / Park Slope";
    if (/Downtown Brooklyn|DUMBO|Boerum Hill|Fort Greene|Brooklyn Heights|Clinton Hill/i.test(n)) return "Downtown Brooklyn / Fort Greene";
    if (/Williamsburg|Greenpoint/i.test(n)) return "Williamsburg / Greenpoint";
    if (/Bushwick|Bedford-Stuyvesant/i.test(n)) return "Bushwick / Bed-Stuy";
    if (/Crown Heights|Prospect Heights/i.test(n)) return "Crown Heights / Prospect Heights";
    if (/Kensington|Windsor Terrace|South Slope/i.test(n)) return "South Brooklyn / Kensington";
  }
  if (b === "Queens") {
    if (/Long Island City|Hunters Point/i.test(n)) return "LIC / Hunters Point";
    if (/Queensbridge|Ravenswood|Dutch Kills|Astoria \(North\)|Old Astoria|Astoria \(Central\)/i.test(n)) return "Astoria / Dutch Kills";
    if (/Sunnyside|Woodside/i.test(n)) return "Sunnyside / Woodside";
    if (/Jamaica/i.test(n)) return "Jamaica / Queens";
  }
  return null;
}
