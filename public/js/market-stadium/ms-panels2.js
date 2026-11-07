// Market Stadium shell layer — panels (2 of 3).
//
// Score breakdown and macro context. The score panel shows the 11 category
// scores and the weighted composite the API returns; the macro panel shows the
// FRED series the dataset carries, latest value and change. Both are read-only.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.panels2) return;

  const PANEL_CLASS = "lucia-ms-score-panel";

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

  async function enhance() {
    if (!/^#\/market-stadium\/?$/.test(window.location.hash || "")) return;
    const main = document.querySelector("main");
    if (!main) return;
    const overview = main.querySelector(".lucia-ms-panel");
    if (!overview || main.querySelector(`.${PANEL_CLASS}`)) return;
    ensureObserver();

    const section = document.createElement("section");
    section.className = `${PANEL_CLASS} lucia-market-stadium`;
    section.setAttribute("aria-label", "Market Stadium score and macro context");
    section.innerHTML = `<div class="lucia-ms-head"><div><h2>Score model &amp; macro</h2><p>How the composite is built, and the FRED series behind it.</p></div><span class="lucia-ms-source">Model</span></div><div class="lucia-ms-body"><p class="lucia-ms-loading">Loading model…</p></div>`;
    overview.insertAdjacentElement("afterend", section);

    const body = section.querySelector(".lucia-ms-body");
    try {
      const [meta, macro] = await Promise.all([
        LMS.api.json("/api/market/meta"),
        LMS.api.json("/api/market/macro")
      ]);
      if (!section.isConnected) return;
      body.replaceChildren();

      const weights = meta.categoryWeights ?? {};
      const weightBox = LMS.h("div", "lucia-ms-card");
      weightBox.appendChild(LMS.h("h3", null, "Category weights"));
      const rows = Object.entries(weights)
        .sort((a, b) => b[1] - a[1])
        .map(([name, w]) => `<tr><td class="nm">${LMS.esc(name)}</td><td>${LMS.fmtNum(w, 2)}</td></tr>`)
        .join("");
      weightBox.appendChild(LMS.ui.table(["Category", "Weight"], rows));
      weightBox.appendChild(LMS.note(meta.model?.score ?? "Weighted mean of the category scores."));
      body.appendChild(weightBox);

      const macroBox = LMS.h("div", "lucia-ms-card");
      macroBox.appendChild(LMS.h("h3", null, "Macro (FRED)"));
      const series = Object.values(macro.series ?? {});
      if (!series.length) {
        macroBox.appendChild(LMS.note("No macro series in this dataset."));
      } else {
        const mrows = series
          .map((s) => {
            const change = Number.isFinite(s.change) ? (s.change > 0 ? "+" : "") + s.change.toFixed(2) : "—";
            return `<tr><td class="nm">${LMS.esc(s.label)}</td><td>${LMS.esc(LMS.fmtByUnit(s.latest?.value, s.unit))}</td><td>${LMS.esc(change)}</td><td>${LMS.esc(s.latest?.date ?? "—")}</td></tr>`;
          })
          .join("");
        macroBox.appendChild(LMS.ui.table(["Series", "Latest", "Change", "As of"], mrows));
      }
      macroBox.appendChild(LMS.note("FRED series (public, keyless) stand in for the captured app's server-side macro feed."));
      body.appendChild(macroBox);

      const proxyBox = LMS.h("div", "lucia-ms-card");
      proxyBox.appendChild(LMS.h("h3", null, "Substituted inputs"));
      const proxies = meta.model?.proxies ?? {};
      const prows = Object.entries(proxies)
        .map(([k, v]) => `<tr><td class="nm">${LMS.esc(k.replace(/_/g, " "))}</td><td>${LMS.esc(v)}</td></tr>`)
        .join("");
      proxyBox.appendChild(LMS.ui.table(["Input", "What is served"], prows));
      proxyBox.appendChild(LMS.note(meta.model?.forecast ?? ""));
      body.appendChild(proxyBox);
    } catch (error) {
      if (!section.isConnected) return;
      body.replaceChildren(LMS.errorBox("Model context failed to load", error));
      console.warn("[market-stadium] score panel failed:", error);
    }
  }

  LMS.panels2 = { enhance, queueEnhance };
})();
