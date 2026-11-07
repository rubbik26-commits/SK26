// Market Stadium shell layer — panels (3 of 3).
//
// Climate risk and market news attachments. Both read the modules this
// repository already ships (server/climate-risk.js, server/market-news.js) and
// render them into lucia's Territory Mastery page. Neither invents a value: a
// geography with no coverage renders the module's own stated reason.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.panels3) return;

  const CLIMATE_CLASS = "lucia-climate-risk";
  const NEWS_CLASS = "lucia-market-news";

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
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { ensureObserver(); queueEnhance(); });
  } else {
    ensureObserver();
    queueEnhance();
  }

  function anchorFor(main) {
    const heading = [...main.querySelectorAll("h1,h2,h3")].find((h) => /know your market/i.test(h.textContent || ""));
    return heading ? heading.closest("section") || heading.parentElement : null;
  }

  function insertAfterAnchor(main, section) {
    const anchor = anchorFor(main);
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement("afterend", section);
    else main.appendChild(section);
  }

  async function climate(main) {
    if (main.querySelector(`.${CLIMATE_CLASS}`)) return;
    const section = document.createElement("section");
    section.className = `${CLIMATE_CLASS} lucia-market-stadium`;
    section.setAttribute("aria-label", "Climate risk");
    section.innerHTML = `<div class="lucia-climate-risk__head"><div><h2>Climate risk</h2><p>FEMA National Risk Index, tract-level with population-weighted roll-up.</p></div><span class="lucia-climate-risk__source">FEMA NRI</span></div><div class="lucia-climate-risk__body"><p class="lucia-climate-risk__muted">Loading climate risk…</p></div>`;
    insertAfterAnchor(main, section);

    const body = section.querySelector(".lucia-climate-risk__body");
    try {
      const level = LMS.state.level;
      const geoid = LMS.state.sel[level];
      const data = await LMS.api.json(`/api/climate-risk?level=${encodeURIComponent(level)}&geoid=${encodeURIComponent(geoid)}`);
      if (!section.isConnected) return;
      body.replaceChildren();

      if (data.configured === false) {
        body.appendChild(LMS.h("p", "lucia-climate-risk__muted", data.reason || "Climate risk is not configured for this deployment."));
        return;
      }
      // The module nests the index under `nri`; a county/MSA row is a
      // population-weighted roll-up of its tracts, so `tracts` is present.
      const nri = data.nri ?? {};
      const facts = [
        ["Composite risk", nri.rating ?? "—"],
        ["Risk score", LMS.fmtNum(nri.risk, 1)],
        ["Expected annual loss", LMS.fmtNum(nri.eal, 1)],
        ["Social vulnerability", LMS.fmtNum(nri.sovi, 1)],
        ["Community resilience", LMS.fmtNum(nri.resl, 1)],
        ["Coverage", nri.tracts != null ? `${LMS.fmtInt(nri.tracts)} tracts` : "direct"]
      ];
      for (const [k, v] of facts) {
        const row = LMS.h("div", "lucia-climate-risk__fact");
        row.append(LMS.h("span", "lucia-climate-risk__k", k), LMS.h("b", null, String(v)));
        body.appendChild(row);
      }
      const hazards = ["coastal", "flood", "heat", "wind", "quake", "fire"]
        .filter((k) => Number.isFinite(nri[k]))
        .sort((a, b) => nri[b] - nri[a])
        .slice(0, 5)
        .map((k) => `${k} ${LMS.fmtNum(nri[k], 1)}`)
        .join(" · ");
      if (hazards) body.appendChild(LMS.h("p", "lucia-climate-risk__criteria", `Top hazards: ${hazards}`));
      body.appendChild(LMS.h("p", "lucia-climate-risk__note", data.source || "FEMA National Risk Index stands in for licensed First Street data."));
    } catch (error) {
      if (!section.isConnected) return;
      body.replaceChildren(LMS.errorBox("Climate risk failed to load", error));
      console.warn("[market-stadium] climate attachment failed:", error);
    }
  }

  async function news(main) {
    if (main.querySelector(`.${NEWS_CLASS}`)) return;
    const section = document.createElement("section");
    section.className = `${NEWS_CLASS} lucia-market-stadium`;
    section.setAttribute("aria-label", "Market news");
    section.innerHTML = `<div class="lucia-market-news__head"><div><h2>Market news</h2><p>Briefs derived from the shipped ACS/PLUTO data, or a proxied live feed.</p></div><span class="lucia-market-news__source">Market</span></div><div class="lucia-market-news__body"><p class="lucia-market-news__muted">Loading market news…</p></div>`;
    insertAfterAnchor(main, section);

    const body = section.querySelector(".lucia-market-news__body");
    try {
      const level = LMS.state.level;
      const geoid = LMS.state.sel[level];
      const data = await LMS.api.json(`/api/market-news?level=${encodeURIComponent(level)}&geoid=${encodeURIComponent(geoid)}`);
      if (!section.isConnected) return;
      body.replaceChildren();

      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        body.appendChild(LMS.h("p", "lucia-market-news__muted", data.reason || "No market news for this geography."));
        return;
      }
      for (const item of items) {
        const row = LMS.h("div", "lucia-market-news__row");
        row.append(
          LMS.h("span", "lucia-market-news__meta", item.kind ?? "Market"),
          LMS.h("span", null, item.headline ?? item.title ?? "")
        );
        if (Number.isFinite(item.value)) {
          row.appendChild(LMS.h("span", "lucia-market-news__amount", LMS.fmtMoneyShort(item.value)));
        }
        body.appendChild(row);
      }
      body.appendChild(LMS.h("p", "lucia-market-news__criteria", `Source: ${data.source ?? "derived"}${data.note ? " — " + data.note : ""}`));
    } catch (error) {
      if (!section.isConnected) return;
      body.replaceChildren(LMS.errorBox("Market news failed to load", error));
      console.warn("[market-stadium] news attachment failed:", error);
    }
  }

  async function enhance() {
    if (!/^#\/territory\/?$/.test(window.location.hash || "")) return;
    const main = document.querySelector("main");
    if (!main) return;
    ensureObserver();
    await news(main);
    await climate(main);
  }

  LMS.panels3 = { enhance, queueEnhance };
})();
