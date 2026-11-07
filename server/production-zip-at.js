import { Router } from "express";
import { soql } from "./adapters/socrata.js";
import { plutoByBbl, plutoRowToBuilding } from "./adapters/nyc.js";

const router = Router();
const TAX_LOT_POLYGONS = "i38t-6if2";
const clean = (v) => {
  const d = String(v ?? "").replace(/[^0-9]/g, "");
  return d.length === 10 ? d : "";
};

router.get("/api/zip-at", async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  // The original's rejection body, measured 2026-08-19: GET /api/zip-at and
  // /api/zip-at?lat=abc&lng=-73.9857 both answer
  //   400 {"error":"Provide ?lat= & ?lng="}
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "Provide ?lat= & ?lng=" });

  const lots = await soql(TAX_LOT_POLYGONS, {
    $select: "bbl",
    $where: `intersects(the_geom, \"POINT(${lng} ${lat})\")`,
    $order: "bbl ASC",
    $limit: 3
  }).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) }));
  if (!lots.live) {
    return res.status(503).json({ provenance: "unavailable", error: "tax_lot_geometry_unavailable", message: lots.error || "DOF Digital Tax Map unavailable" });
  }

  const bbls = [...new Set((lots.rows || []).map((r) => clean(r.bbl)).filter(Boolean))];
  if (!bbls.length) {
    // A live polygon query with no hit is authoritative: water/outside a tax lot.
    // {zip} and nothing else. Measured: a point in open water answers
    // {"zip":null} and a point on a lot answers {"zip":"10001"} — one key.
    return res.json({ zip: null });
  }
  if (bbls.length > 1) {
    return res.status(409).json({
      provenance: "unavailable",
      error: "ambiguous_lot_boundary",
      message: "The point intersects more than one tax-lot polygon boundary. No neighboring parcel was chosen by centroid distance.",
      bbls
    });
  }

  const bbl = bbls[0];
  const pluto = await plutoByBbl(bbl).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) }));
  if (!pluto.live) {
    return res.status(503).json({ provenance: "unavailable", error: "pluto_unavailable", message: pluto.error || "PLUTO unavailable", bbl });
  }
  if (!pluto.rows?.length) {
    // The lot polygon is a published fact even when current PLUTO has no row
    // (retired/merged edge cases). Do not invent a ZIP.
    return res.json({ zip: null });
  }
  const building = plutoRowToBuilding(pluto.rows[0]);
  return res.json({ zip: building.zip || null });
});

export default router;
