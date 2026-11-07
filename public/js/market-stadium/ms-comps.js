// Market Stadium shell layer — Comps / Land Index attachment (§5 of
// the integration plan). On #/comps, injects a strip carrying the
// Market Stadium sales file for a ZIP (default: the surface's selected
// ZIP) from /api/market/sales?zip= — labelled as the DOF rolling-
// calendar file it is. lucia's own /api/market-report and
// /api/market-index contracts are untouched.
(() => {
  const LMS = window.LuciaMarketStadium;
  const PANEL_CLASS = "lucia-ms-comps-panel";

  // Building-class labels for the by-class split. Names are the NYC
  // PLUTO data dictionary's Appendix C building-class names (the
  // Department of Finance PTS classes the DOF rolling sales file
  // carries), for the two apartment families that file contains.
  // A code with no entry renders as the code itself — never as a
  // placeholder — and the /api/market/sales entries are counts
  // ({ code: n }); an object entry ({ count, avg_price }) is read
  // the same way when one is ever served.
  const CLASS_LABELS = {
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
  const classSegment = ([code, entry]) => {
    const label = CLASS_LABELS[code] || String(code);
    const count = typeof entry === "number" ? entry : entry?.count;
    const avg = typeof entry === "object" && entry !== null && Number.isFinite(entry.avg_price) ? ` (avg ${LMS.fmtMoneyShort(entry.avg_price)})` : "";
    return `${code} ${label}: ${Number.isFinite(count) ? LMS.fmtInt(count) : "—"}${avg}`;
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
    const zip0 = LMS.state.sel.zip || "10028";
    section.innerHTML = `<h2>Market Stadium — sales file</h2>
      <p class="lucia-ms-sub">DOF Rolling Calendar Sales (NYC Open Data usep-8jbt) with the ACRIS partial-interest join, served by /api/market/sales — a separate file from this page's own market-report contract.</p>
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
        const f = data.filtered || {};
        body.appendChild(LMS.kv(`ZIP ${zip} — sales in file`, `${LMS.fmtInt(f.count)} · avg ${LMS.fmtMoneyShort(f.avg_price)}`));
        if (f.by_class) {
          body.appendChild(LMS.h("div", "lucia-ms-sub", Object.entries(f.by_class).map(classSegment).join(" · ")));
        }
        const rows = (data.results || []).map((r) => `<tr><td class="nm">${LMS.esc(r.address || "—")}${r.partial_interest ? ` <span class="chip warn">Partial interest · ${r.partial_interest_pct ?? "—"}%</span>` : ""}</td><td>${LMS.esc(r.sale_date || "—")}</td><td>${LMS.esc(r.bldg_class || "—")}</td><td>${LMS.fmtMoney(r.sale_price)}</td></tr>`).join("");
        body.appendChild(LMS.ui.table(["Address", "Date", "Class", "Price"], rows));
        body.appendChild(LMS.note(`Window ${data.all_cd_sales?.window?.[0] || ""} → ${data.all_cd_sales?.window?.[1] || ""} across the full file (${LMS.fmtInt(data.total)} sales). Full panel: the “Sales” panel of the Market Stadium surface.`));
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
})();
