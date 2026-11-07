// Market Stadium shell layer — Territory Mastery attachment (§5 of the
// integration plan). On #/territory, injects a Market Stadium section
// under the page's market content: the top-10 metro ranking, the
// surface's currently selected geography (scores + key stats) and a
// macro latest-values strip — all from /api/market/*. The page's own
// news attachment is the market-news layer; this section sits after
// it when present.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.territory) return;
  const PANEL_CLASS = "lucia-ms-territory-panel";

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

  function anchorSection(doc) {
    const news = doc.querySelector(".lucia-market-news");
    if (news) return news;
    const heading = [...doc.querySelectorAll("h1,h2,h3")].find((h) => /know your market/i.test(h.textContent || ""));
    return heading ? heading.closest("section") || heading.parentElement : null;
  }

  async function enhance() {
    if (!/^#\/territory\/?$/.test(window.location.hash || "")) return;
    const main = document.querySelector("main");
    if (!main || main.querySelector(`.${PANEL_CLASS}`)) return;
    ensureObserver();

    const section = document.createElement("section");
    section.className = `${PANEL_CLASS} lucia-market-stadium`;
    section.setAttribute("aria-label", "Market Stadium market context");
    section.innerHTML = `<h2>Market Stadium — market context</h2><p class="lucia-ms-sub">Live percentile-model context from /api/market/* — the public-data build (docs/market-stadium-api.md). Open the full surface from the “Market Stadium” rail entry.</p><div class="lucia-ms-territory-body"><p class="lucia-ms-loading">Loading market context…</p></div>`;
    const anchor = anchorSection(document);
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement("afterend", section);
    else main.appendChild(section);

    const body = section.querySelector(".lucia-ms-territory-body");
    try {
      const level = LMS.state.level;
      const geoid = LMS.state.sel[level];
      const [top, payload, macro] = await Promise.all([
        LMS.api.json("/api/market/records/cbsa?sort=c&limit=10"),
        LMS.api.json(`/api/market/record/${level}/${encodeURIComponent(geoid)}`),
        LMS.api.json("/api/market/macro")
      ]);
      if (!section.isConnected) return;
      body.replaceChildren();
      const rec = payload.record;
      const selBox = document.createElement("div");
      selBox.innerHTML = `<h3>Selected geography — ${LMS.esc(rec.name)} (${LMS.esc(level)} ${LMS.esc(rec.geoid)})</h3>`;
      const tiles = LMS.h("div", "lucia-ms-tiles");
      for (const [kind, label] of [["c", "Current"], ["g", "Growth"], ["f", "Forecast"]]) {
        const t = LMS.h("div", "lucia-ms-tile");
        t.append(LMS.h("span", null, label), LMS.h("b", null, LMS.fmtScore(payload.scores[kind])), LMS.h("em", null, payload.tiers[kind] != null ? `Tier ${payload.tiers[kind]}` : "—"));
        tiles.appendChild(t);
      }
      selBox.append(
        tiles,
        LMS.kv("Population", LMS.fmtInt(rec.dem023c1)),
        LMS.kv("Median HH income", LMS.fmtMoney(rec.hcap001c1)),
        LMS.kv("Median home value", LMS.fmtMoney(rec.hval001c1)),
        LMS.kv("Median rent", LMS.fmtRent(rec.hou002c1))
      );
      body.appendChild(selBox);

      const rankBox = document.createElement("div");
      rankBox.innerHTML = "<h3>Top 10 metros — Current</h3>";
      const rows = (top.results || []).map((r) => `<tr data-geoid="${LMS.esc(r.geoid)}"><td>${r.rank ?? ""}</td><td class="nm">${LMS.esc(r.name)}</td><td>${LMS.fmtScore(r.score_c)}</td><td>${r.tier_c != null ? "T" + r.tier_c : "—"}</td></tr>`).join("");
      const table = LMS.ui.table(["Rank", "Metro", "Current", "Tier"], rows);
      table.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => {
        LMS.state.level = "cbsa";
        LMS.state.sel.cbsa = tr.dataset.geoid;
        window.location.hash = "#/market-stadium";
      }));
      rankBox.appendChild(table);
      body.appendChild(rankBox);

      const macroBox = document.createElement("div");
      const series = Object.values(macro.series || {}).slice(0, 4);
      macroBox.innerHTML = `<h3>Macro (FRED)</h3>` + series.map((s) => `<div class="lucia-ms-kv"><span>${LMS.esc(s.label || "")}</span><b>${LMS.esc(LMS.ui.fmtByUnit(s.latest?.value, s.unit))}</b></div>`).join("");
      body.appendChild(macroBox);
    } catch (error) {
      if (!section.isConnected) return;
      body.replaceChildren(LMS.errorBox("Market Stadium context failed to load", error));
      console.warn("[market-stadium] territory attachment failed:", error);
    }
  }

  LMS.territory = { enhance, queueEnhance };
})();
