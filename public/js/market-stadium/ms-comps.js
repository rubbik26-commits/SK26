// Market Stadium shell layer — Comps / Land Index attachment (§5 of
// the integration plan). On #/comps, injects a strip carrying the
// Market Stadium sales file for a ZIP (default: the surface's selected
// ZIP) from /api/market/sales?zip= — labelled as the DOF rolling-
// calendar file it is. lucia's own /api/market-report and
// /api/market-index contracts are untouched.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.comps) return;
  const PANEL_CLASS = "lucia-ms-comps-panel";

  // Building-class labels for the by-class split. Names are the NYC
  // PLUTO data dictionary's Appendix C building-class names (the
  // Department of Finance PTS classes the DOF rolling sales file
  // carries). A code with no entry renders as the code itself — never
  // as a placeholder.
  const CLASS_LABELS = {
    A1: "One family dwellings: detached",
    A2: "One family dwellings: semi-detached",
    A3: "One family dwellings: attached",
    A4: "One family dwellings: city residence",
    A5: "One family dwellings: attached or semi-detached",
    A6: "One family dwellings: summer cottages",
    A7: "One family dwellings: mansion type",
    A8: "One family dwellings: bungalow colonies",
    A9: "One family dwellings: miscellaneous",
    B1: "Two family dwellings: brick",
    B2: "Two family dwellings: frame",
    B3: "Two family dwellings: converted from one family",
    B9: "Two family dwellings: miscellaneous",
    C0: "Walk-up apartments: three families",
    C1: "Walk-up apartments: over six families without stores",
    C2: "Walk-up apartments: five to six families",
    C3: "Walk-up apartments: four families",
    C4: "Walk-up apartments: old law tenements",
    C5: "Walk-up apartments: converted dwelling or rooming house",
    C6: "Walk-up apartments: cooperative (other than condominiums)",
    C7: "Walk-up apartments: over six families with stores",
    C8: "Walk-up apartments: co-op conversion from loft/warehouse",
    C9: "Walk-up apartments: garden apartments / mobile home park",
    D0: "Elevator apartments: co-op conversion from loft/warehouse",
    D1: "Elevator apartments: semi-fireproof (without stores)",
    D2: "Elevator apartments: artists in residence",
    D3: "Elevator apartments: fireproof (standard construction without stores)",
    D4: "Elevator apartments: cooperatives (other than condominiums)",
    D5: "Elevator apartments: converted",
    D6: "Elevator apartments: fireproof, with stores",
    D7: "Elevator apartments: semi-fireproof, with stores",
    D8: "Elevator apartments: luxury type",
    D9: "Elevator apartments: miscellaneous"
  };

  let observer = null;
  let scheduled = false;
  function queueEnhance() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      void enhance();
    });
  }
  function ensureObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(queueEnhance);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener("hashchange", queueEnhance);
  window.addEventListener("popstate", queueEnhance);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { ensureObserver(); queueEnhance(); });
  else { ensureObserver(); queueEnhance(); }

  async function enhance() {
    if (!/^#\/comps\/?$/.test(window.location.hash || "")) return;
    const main = document.querySelector("main");
    if (!main || main.querySelector(`.${PANEL_CLASS}`)) return;
    ensureObserver();

    const section = document.createElement("section");
    section.className = `${PANEL_CLASS} lucia-market-stadium`;
    section.setAttribute("aria-label", "Market Stadium sales file strip");
    const zip0 = LMS.state.sel.zipcode || "10028";
    section.innerHTML = `<h2>Market Stadium — sales file</h2>
      <p class="lucia-ms-sub">DOF Rolling Calendar Sales with the ACRIS partial-interest join, served by /api/market/sales — a separate file from this page's own market-report contract.</p>
      <div class="lucia-ms-controls"><label>ZIP <input class="lucia-ms-input lucia-ms-comps-zip" value="${LMS.esc(zip0)}" size="6"></label><button type="button" class="lucia-ms-btn small lucia-ms-comps-go">Load sales</button></div>
      <div class="lucia-ms-comps-body"><p class="lucia-ms-loading">Loading sales…</p></div>`;
    const heading = main.querySelector("h1,h2");
    const anchor = heading ? heading.closest("section") || heading.parentElement : null;
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement("afterend", section);
    else main.appendChild(section);

    const body = section.querySelector(".lucia-ms-comps-body");
    const input = section.querySelector(".lucia-ms-comps-zip");
    const load = async () => {
      const zip = (input.value || "").trim();
      body.replaceChildren(LMS.h("p", "lucia-ms-loading", "Loading sales…"));
      try {
        const data = await LMS.api.json(`/api/market/sales?zip=${encodeURIComponent(zip)}&limit=8`);
        if (!section.isConnected) return;
        body.replaceChildren();

        // The route answers the shipped file's own shape: { sales: [...] }.
        const all = Array.isArray(data.sales) ? data.sales : [];
        const rows = all.slice(0, 8);
        const prices = all.map((r) => r.price).filter((v) => Number.isFinite(v));
        const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

        body.appendChild(LMS.kv(`ZIP ${zip} — sales in file`, `${LMS.fmtInt(all.length)} · avg ${LMS.fmtMoneyShort(avg)}`));

        const byClass = new Map();
        for (const r of all) {
          const code = r.class || "—";
          byClass.set(code, (byClass.get(code) || 0) + 1);
        }
        if (byClass.size) {
          const split = [...byClass.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([code, n]) => `${code} ${CLASS_LABELS[code] || code}: ${LMS.fmtInt(n)}`)
            .join(" · ");
          body.appendChild(LMS.h("div", "lucia-ms-sub", split));
        }

        const html = rows
          .map((r) => `<tr><td class="nm">${LMS.esc(r.address || "—")}</td><td>${LMS.esc(r.date || "—")}</td><td>${LMS.esc(r.class || "—")}</td><td>${LMS.fmtMoney(r.price)}</td></tr>`)
          .join("");
        body.appendChild(LMS.ui.table(["Address", "Date", "Class", "Price"], html));
        body.appendChild(LMS.note(`Showing ${rows.length} of ${LMS.fmtInt(all.length)} sales in the shipped file. Full panel: the “Sales” panel of the Market Stadium surface.`));
      } catch (error) {
        if (!section.isConnected) return;
        body.replaceChildren(LMS.errorBox("Market Stadium sales failed to load", error));
        console.warn("[market-stadium] comps attachment failed:", error);
      }
    };
    section.querySelector(".lucia-ms-comps-go").addEventListener("click", load);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void load(); });
    void load();
  }

  LMS.comps = { enhance, queueEnhance };
})();
