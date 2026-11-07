// Market Stadium shell layer — panels (1 of 3).
//
// The in-lucia Market Stadium surface: a level switcher, the choropleth, the
// selected geography's score card and the top-ranked table. Every value comes
// from /api/market/*; nothing is synthesised. A level with no dataset yet shows
// its loading state rather than a zero.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.panels) return;

  const PANEL_CLASS = "lucia-ms-panel";

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

  function buildShell() {
    const section = document.createElement("section");
    section.className = `${PANEL_CLASS} lucia-market-stadium`;
    section.setAttribute("aria-label", "Market Stadium market overview");

    const head = LMS.h("div", "lucia-ms-head");
    const titles = LMS.h("div");
    titles.append(
      LMS.h("h2", null, "Market Stadium — market overview"),
      LMS.h("p", null, "National percentile model over ACS 5-year + TIGER 2024. Read-only context from /api/market/*.")
    );
    head.append(titles, LMS.h("span", "lucia-ms-source", "ACS · TIGER · FEMA · FRED"));

    const controls = LMS.h("div", "lucia-ms-controls");
    const levelSel = LMS.h("select", "lucia-ms-input lucia-ms-level");
    for (const level of LMS.LEVELS) {
      const opt = LMS.h("option", null, LMS.LEVEL_LABELS[level]);
      opt.value = level;
      if (level === LMS.state.level) opt.selected = true;
      levelSel.appendChild(opt);
    }
    const search = LMS.h("input", "lucia-ms-input lucia-ms-search");
    search.placeholder = "Address, ZIP or place name";
    search.setAttribute("aria-label", "Search a place");
    const go = LMS.h("button", "lucia-ms-btn small lucia-ms-go", "Search");
    go.type = "button";
    controls.append(levelSel, search, go);

    const mapBox = LMS.h("div", "lucia-ms-map");
    mapBox.setAttribute("role", "img");
    mapBox.setAttribute("aria-label", "Choropleth of the selected geography level");

    const body = LMS.h("div", "lucia-ms-body");
    body.append(LMS.h("p", "lucia-ms-loading", "Loading market data…"));

    section.append(head, controls, mapBox, body);
    return { section, levelSel, search, go, mapBox, body };
  }

  async function renderBody(body, level) {
    const geoid = LMS.state.sel[level];
    const [record, ranked] = await Promise.all([
      LMS.api.json(`/api/market/record/${level}/${encodeURIComponent(geoid)}`),
      LMS.api.json(`/api/market/records/${level}?sort=c&limit=10`)
    ]);

    const rec = record.record;
    const score = record.scores?.c ?? null;
    const tier = record.tiers?.c ?? LMS.tierFromScore(score);

    body.replaceChildren();

    const card = LMS.h("div", "lucia-ms-card");
    const cardHead = LMS.h("div", "lucia-ms-cardhead");
    const badge = LMS.h("span", "lucia-ms-badge", LMS.fmtScore(score));
    badge.style.background = LMS.tierColor(tier);
    cardHead.append(
      LMS.h("b", null, rec.name),
      badge,
      LMS.h("em", null, `${LMS.LEVEL_LABELS[level]} ${rec.geoid} · Tier ${tier ?? "—"} · ${LMS.tierBand(tier)}`)
    );
    card.appendChild(cardHead);

    const tiles = LMS.h("div", "lucia-ms-tiles");
    for (const [label, value] of [
      ["Population", LMS.fmtInt(rec.dem023c1)],
      ["Households", LMS.fmtInt(rec.dem001c1)],
      ["Median HH income", LMS.fmtMoney(rec.hcap001c1)],
      ["Median home value", LMS.fmtMoney(rec.hval001c1)],
      ["Median rent", LMS.fmtRent(rec.hou002c1)],
      ["Poverty rate", LMS.fmtPct(rec.pov001c1)]
    ]) {
      const tile = LMS.h("div", "lucia-ms-tile");
      tile.append(LMS.h("span", null, label), LMS.h("b", null, value));
      tiles.appendChild(tile);
    }
    card.appendChild(tiles);

    const cats = rec.cats && typeof rec.cats === "object" ? Object.entries(rec.cats) : [];
    if (cats.length) {
      const catBox = LMS.h("div", "lucia-ms-cats");
      catBox.appendChild(LMS.h("h3", null, "Category scores"));
      for (const [name, value] of cats) {
        const row = LMS.h("div", "lucia-ms-cat");
        const bar = LMS.h("i");
        bar.style.width = `${Math.max(0, Math.min(100, (Number(value) || 0) * 10))}%`;
        bar.style.background = LMS.tierColor(LMS.tierFromScore(value));
        row.append(LMS.h("span", null, name), LMS.h("b", null, LMS.fmtScore(value)), bar);
        catBox.appendChild(row);
      }
      card.appendChild(catBox);
    }
    body.appendChild(card);

    const rankBox = LMS.h("div", "lucia-ms-card");
    rankBox.appendChild(LMS.h("h3", null, `Top 10 — ${LMS.LEVEL_LABELS[level]} by composite`));
    const rows = (ranked.results ?? [])
      .map((r) => `<tr data-geoid="${LMS.esc(r.geoid)}"><td>${r.rank}</td><td class="nm">${LMS.esc(r.name)}</td><td>${LMS.fmtScore(r.score_c)}</td><td>${r.tier_c != null ? "T" + r.tier_c : "—"}</td></tr>`)
      .join("");
    const table = LMS.ui.table(["#", "Place", "Score", "Tier"], rows);
    table.querySelectorAll("tbody tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        LMS.state.sel[level] = tr.dataset.geoid;
        queueEnhance();
      });
    });
    rankBox.appendChild(table);
    rankBox.appendChild(LMS.note(`Ranked ${LMS.fmtInt(ranked.total)} places with a composite score at this level.`));
    body.appendChild(rankBox);
  }

  async function enhance() {
    if (!/^#\/market-stadium\/?$/.test(window.location.hash || "")) return;
    const main = document.querySelector("main");
    if (!main) return;
    ensureObserver();

    let shell = main.querySelector(`.${PANEL_CLASS}`);
    if (!shell) {
      const built = buildShell();
      shell = built.section;
      const heading = main.querySelector("h1,h2");
      const anchor = heading ? heading.closest("section") || heading.parentElement : null;
      if (anchor && anchor.parentNode) anchor.insertAdjacentElement("afterend", shell);
      else main.appendChild(shell);

      built.levelSel.addEventListener("change", () => {
        LMS.state.level = built.levelSel.value;
        queueEnhance();
      });
      const runSearch = async () => {
        const q = built.search.value.trim();
        if (!q) return;
        built.body.replaceChildren(LMS.h("p", "lucia-ms-loading", "Resolving address…"));
        try {
          const hit = await LMS.geocoder.resolve(q);
          const applied = LMS.geocoder.apply(hit);
          if (!applied) {
            built.body.replaceChildren(LMS.note(`No Census geography matched “${q}”.`));
            return;
          }
          built.levelSel.value = applied.level;
          queueEnhance();
        } catch (error) {
          built.body.replaceChildren(LMS.errorBox("Address lookup failed", error));
        }
      };
      built.go.addEventListener("click", runSearch);
      built.search.addEventListener("keydown", (e) => { if (e.key === "Enter") void runSearch(); });
    }

    const level = LMS.state.level;
    const body = shell.querySelector(".lucia-ms-body");
    const mapBox = shell.querySelector(".lucia-ms-map");
    const levelSel = shell.querySelector(".lucia-ms-level");
    if (levelSel && levelSel.value !== level) levelSel.value = level;

    try {
      await LMS.map.mount(mapBox, level);
      await renderBody(body, level);
    } catch (error) {
      body.replaceChildren(LMS.errorBox("Market Stadium data failed to load", error));
      console.warn("[market-stadium] overview panel failed:", error);
    }
  }

  LMS.panels = { enhance, queueEnhance };
})();
