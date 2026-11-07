// Market Stadium shell layer — CSV export.
//
// Exports the active level's ranked rows as CSV, client-side, from the same
// /api/market/* data the panels render. No server round trip and no new
// endpoint; the file is built from what is already on screen.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.export) return;

  const COLUMNS = [
    ["rank", "#"],
    ["geoid", "GEOID"],
    ["name", "Place"],
    ["score_c", "Composite"],
    ["tier_c", "Tier"]
  ];

  function toCsv(rows) {
    const escape = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = COLUMNS.map(([, label]) => escape(label)).join(",");
    const body = rows.map((r) => COLUMNS.map(([key]) => escape(r[key])).join(",")).join("\n");
    return `${head}\n${body}\n`;
  }

  async function download(level = LMS.state.level, limit = 500) {
    const data = await LMS.api.json(`/api/market/records/${level}?sort=c&limit=${limit}`);
    const csv = toCsv(data.results ?? []);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `market-stadium-${level}-top${limit}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return (data.results ?? []).length;
  }

  LMS.export = { download, toCsv };
})();
