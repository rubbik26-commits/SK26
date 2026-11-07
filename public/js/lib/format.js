// Formatting helpers shared by every page.
export const num = (n) => (n == null || !Number.isFinite(+n) ? "—" : Math.round(+n).toLocaleString());
export const usd = (n) => (n == null || !Number.isFinite(+n) || +n <= 0 ? "—" : `$${Math.round(+n).toLocaleString()}`);
export const usdBig = (n) => {
  if (!n || !Number.isFinite(+n)) return "—";
  const v = +n;
  return v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v).toLocaleString()}`;
};
export const pct = (n, d = 0) => (n == null || !Number.isFinite(+n) ? "—" : `${(+n).toFixed(d)}%`);
export const fixed = (n, d = 2) => (n == null || !Number.isFinite(+n) ? "—" : (+n).toFixed(d));
export const sf = (n) => {
  if (n == null || !Number.isFinite(+n)) return "—";
  const v = +n;
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M sf` : v >= 1e3 ? `${Math.round(v / 1e3)}k sf` : `${v} sf`;
};
export const dateShort = (d) => (d ? String(d).slice(0, 10) : "—");
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function exportCsv(filename, columns, rows) {
  const head = columns.map((c) => csvCell(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(String(c.value(r) ?? ""))).join(",")).join("\n");
  downloadBlob(new Blob(["﻿" + head + "\n" + body], { type: "text/csv;charset=utf-8" }), filename.endsWith(".csv") ? filename : `${filename}.csv`);
}
export function exportXls(filename, columns, rows) {
  const th = `<tr>${columns.map((c) => `<th>${esc(c.header)}</th>`).join("")}</tr>`;
  const trs = rows.map((r) => `<tr>${columns.map((c) => `<td>${esc(String(c.value(r) ?? ""))}</td>`).join("")}</tr>`).join("");
  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table border="1">${th}${trs}</table></body></html>`;
  downloadBlob(new Blob(["﻿" + html], { type: "application/vnd.ms-excel;charset=utf-8" }), filename.endsWith(".xls") ? filename : `${filename}.xls`);
}

export const BUILDING_EXPORT_COLUMNS = [
  { header: "Address", value: (b) => b.address }, { header: "BBL", value: (b) => b.bbl },
  { header: "Borough", value: (b) => b.borough }, { header: "Block", value: (b) => b.block },
  { header: "Lot", value: (b) => b.lot }, { header: "ZIP", value: (b) => b.zip },
  { header: "Dev score", value: (b) => b.score }, { header: "Sell propensity", value: (b) => b.propensity ?? "" },
  { header: "Land use", value: (b) => b.landUse ?? "" }, { header: "Bldg class", value: (b) => b.bldgClass ?? "" },
  { header: "Owner", value: (b) => b.owner ?? "" }, { header: "Zoning", value: (b) => b.zoning ?? "" },
  { header: "Special district", value: (b) => b.specialDistrict ?? "" },
  { header: "Lot area (sf)", value: (b) => b.lotArea ?? "" }, { header: "Bldg area (sf)", value: (b) => b.bldgArea ?? "" },
  { header: "Resi area (sf)", value: (b) => b.resArea ?? "" }, { header: "Comm area (sf)", value: (b) => b.comArea ?? "" },
  { header: "Floors", value: (b) => b.numFloors ?? "" }, { header: "Resi units", value: (b) => b.unitsRes ?? "" },
  { header: "Total units", value: (b) => b.unitsTotal ?? "" }, { header: "Year built", value: (b) => b.yearBuilt ?? "" },
  { header: "Built FAR", value: (b) => b.builtFar ?? "" }, { header: "Max FAR", value: (b) => b.maxFar ?? "" },
  { header: "Unused buildable (sf)", value: (b) => b.unusedFarSf ?? "" },
  { header: "Assessed land", value: (b) => b.assessLand ?? "" }, { header: "Assessed total", value: (b) => b.assessTotal ?? "" },
  { header: "Latitude", value: (b) => b.lat ?? "" }, { header: "Longitude", value: (b) => b.lng ?? "" }
];
