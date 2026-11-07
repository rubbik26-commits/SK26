// Market Stadium shell layer — shared namespace + API client.
//
// The Market Stadium surface is mounted at /market/ and reads its dataset from
// its own static tree. This layer is the *lucia-side* integration: it lets
// lucia's own pages (Territory Mastery, Comps) carry Market Stadium context
// without editing the checksum-pinned application bundle.
//
// Everything here is read-only. No lucia data, formula, persistence or API
// contract is touched; the layer only reads /api/market/* and renders into
// elements it created itself.
(() => {
  if (window.LuciaMarketStadium) return;

  const LEVELS = ["cbsa", "county", "zipcode", "tract"];
  const LEVEL_LABELS = { cbsa: "Metro (MSA)", county: "County", zipcode: "ZIP", tract: "Census Tract" };

  // The surface's own 10-step tier palettes, copied verbatim from
  // app-market/src/theme/tokens.ts. Tier 1 is best.
  const TIERS = {
    classic: {
      1: "#1D2CF3", 2: "#1362F2", 3: "#008AFC", 4: "#06AFED", 5: "#A1D2E8",
      6: "#D4E157", 7: "#FFE589", 8: "#FFB326", 9: "#FF7411", 10: "#E90303"
    },
    calm: {
      1: "#1A2FB8", 2: "#1D3FD6", 3: "#2152E8", 4: "#2563EB", 5: "#3B82F6",
      6: "#60A5FA", 7: "#93C5FD", 8: "#BFDBFE", 9: "#DBEAFE", 10: "#EFF6FF"
    }
  };

  const state = {
    level: "cbsa",
    sel: { cbsa: "35620", county: "36061", zipcode: "10028", tract: "36061013604" },
    palette: (() => {
      try {
        return localStorage.getItem("ms.tierPalette") === "calm" ? "calm" : "classic";
      } catch {
        return "classic";
      }
    })()
  };

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—");
  const fmtNum = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
  const fmtScore = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
  const fmtMoney = (v) => (Number.isFinite(v) ? "$" + Math.round(v).toLocaleString("en-US") : "—");
  const fmtMoneyShort = (v) => {
    if (!Number.isFinite(v)) return "—";
    const abs = Math.abs(v);
    if (abs >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return "$" + (v / 1e3).toFixed(0) + "K";
    return "$" + Math.round(v).toLocaleString("en-US");
  };
  // Monthly rent must never be abbreviated — "$2K" reads as a sale price.
  const fmtRent = (v) => (Number.isFinite(v) ? "$" + Math.round(v).toLocaleString("en-US") + "/mo" : "—");
  const fmtPct = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) + "%" : "—");

  const fmtByUnit = (v, unit) => {
    if (!Number.isFinite(v)) return "—";
    switch (unit) {
      case "usd": return fmtMoney(v);
      case "usd_month": return fmtRent(v);
      case "pct": return fmtPct(v);
      case "per_sqmi": return fmtInt(v) + " /sq mi";
      case "years": return v.toFixed(1);
      case "ratio": return v.toFixed(1);
      case "people_per_unit": return v.toFixed(2);
      default: return fmtInt(v);
    }
  };

  /** tier = 11 - ceil(score), clamped 1..10 — the surface's own legend rule. */
  const tierFromScore = (score) => {
    if (!Number.isFinite(score)) return null;
    return Math.max(1, Math.min(10, 11 - Math.ceil(score)));
  };
  const tierColor = (tier) => {
    if (!tier) return "#cbd5e1";
    const t = Math.max(1, Math.min(10, Math.round(tier)));
    return TIERS[state.palette][t];
  };
  const tierBand = (tier) => {
    if (!tier) return "No data";
    if (tier <= 3) return "Higher";
    if (tier <= 7) return "Middle";
    return "Lower";
  };

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  };

  const kv = (label, value) => {
    const row = h("div", "lucia-ms-kv");
    row.append(h("span", null, label), h("b", null, value));
    return row;
  };

  const note = (text) => h("p", "lucia-ms-note", text);

  const errorBox = (title, error) => {
    const box = h("div", "lucia-ms-error");
    box.append(h("b", null, title), h("span", null, String(error?.message ?? error)));
    return box;
  };

  const ui = {
    fmtByUnit,
    table(headers, rowsHtml) {
      const wrap = h("div", "lucia-ms-tablewrap");
      const table = h("table", "lucia-ms-table");
      const thead = h("thead");
      const hr = h("tr");
      for (const label of headers) hr.appendChild(h("th", null, label));
      thead.appendChild(hr);
      const tbody = h("tbody");
      tbody.innerHTML = rowsHtml || "";
      table.append(thead, tbody);
      wrap.appendChild(table);
      return wrap;
    }
  };

  const api = {
    async json(url) {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
      return body;
    }
  };

  window.LuciaMarketStadium = {
    LEVELS,
    LEVEL_LABELS,
    TIERS,
    state,
    esc,
    fmtInt,
    fmtNum,
    fmtScore,
    fmtMoney,
    fmtMoneyShort,
    fmtRent,
    fmtPct,
    fmtByUnit,
    tierFromScore,
    tierColor,
    tierBand,
    h,
    kv,
    note,
    errorBox,
    ui,
    api
  };
})();
