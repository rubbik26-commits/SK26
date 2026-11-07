// Exhaustive Rolling Sales pull for calculations that publish counts, medians
// or averages over a stated universe. UI lists may intentionally use bounded
// adapters; an authority calculation may not silently inherit that cap.
import { soqlAll, escSoql } from "./socrata.js";
import { DS, parseSalesNum } from "./nyc.js";

const num = (v) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const day = (v) => String(v ?? "").slice(0, 10) || null;

export async function completeRollingSalesByZips(zips, { sinceDays = 366, minPrice = 10000 } = {}) {
  const clean = [...new Set((zips || []).map((z) => String(z).trim()).filter((z) => /^\d{5}$/.test(z)))];
  if (!clean.length) return { live: false, rows: [], error: "zips_required" };
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString().slice(0, 10);
  const list = clean.map((z) => `'${escSoql(z)}'`).join(",");
  const r = await soqlAll(DS.rollingSales, {
    $where: `zip_code in (${list}) AND sale_date >= '${since}T00:00:00'`,
    $order: "sale_date DESC,borough ASC,block ASC,lot ASC"
  }, {
    pageSize: 5000,
    maxRows: 250000,
    timeoutMs: 30000,
    ttlMs: 30 * 60 * 1000,
    retries: 2
  });
  if (!r.live || r.complete !== true) return { live: false, rows: [], error: r.error || "rolling_sales_incomplete" };

  const rows = (r.rows || []).map((s) => ({
    saleDate: day(s.sale_date),
    salePrice: num(s.sale_price),
    address: s.address || "",
    bldgClass: s.building_class_at_present || "",
    category: s.building_class_category || "",
    grossSf: parseSalesNum(s.gross_square_feet),
    landSf: parseSalesNum(s.land_square_feet),
    unitsRes: num(s.residential_units),
    zip: String(s.zip_code || ""),
    ppsf: parseSalesNum(s.gross_square_feet) > 0 && num(s.sale_price) > 0
      ? Math.round(num(s.sale_price) / parseSalesNum(s.gross_square_feet)) : null,
    bbl: s.borough && s.block && s.lot
      ? `${s.borough}${String(s.block).padStart(5, "0")}${String(s.lot).padStart(4, "0")}` : null
  })).filter((s) => Number(s.salePrice) > minPrice);

  return { live: true, complete: true, rows, since, sourceRows: r.rows.length };
}
