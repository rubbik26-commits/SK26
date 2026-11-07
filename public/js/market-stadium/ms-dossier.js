// Market Stadium shell layer — Parcel Dossier attachment.
//
// On lucia's Parcel Dossier, adds the Market Stadium context for the parcel's
// own geography: the tract/county composite and tier, plus the PLUTO lot the
// dataset carries when the BBL is present. Read-only; lucia's own dossier
// contract and its /api/asset-history data are untouched.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.dossier) return;

  const PANEL_CLASS = "lucia-ms-dossier-panel";

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

  /** A BBL is 10 digits: borough(1) + block(5) + lot(4). */
  function bblFromHash() {
    const m = (window.location.hash || "").match(/(\d{10})/);
    return m ? m[1] : null;
  }

  async function enhance() {
    if (!/^#\/dossier\/?/.test(window.location.hash || "")) return;
    const main = document.querySelector("main");
    if (!main || main.querySelector(`.${PANEL_CLASS}`)) return;
    ensureObserver();

    const section = document.createElement("section");
    section.className = `${PANEL_CLASS} lucia-market-stadium`;
    section.setAttribute("aria-label", "Market Stadium parcel context");
    section.innerHTML = `<div class="lucia-ms-head"><div><h2>Market Stadium — parcel context</h2><p>National percentile context for this parcel's geography, from /api/market/*.</p></div><span class="lucia-ms-source">ACS · PLUTO</span></div><div class="lucia-ms-body"><p class="lucia-ms-loading">Loading parcel context…</p></div>`;
    const heading = main.querySelector("h1,h2");
    const anchor = heading ? heading.closest("section") || heading.parentElement : null;
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement("afterend", section);
    else main.appendChild(section);

    const body = section.querySelector(".lucia-ms-body");
    try {
      const bbl = bblFromHash();
      const level = "county";
      const geoid = LMS.state.sel[level];
      const [record, pluto] = await Promise.all([
        LMS.api.json(`/api/market/record/${level}/${encodeURIComponent(geoid)}`),
        bbl ? LMS.api.json("/api/market/pluto").catch(() => null) : Promise.resolve(null)
      ]);
      if (!section.isConnected) return;
      body.replaceChildren();

      const rec = record.record;
      const score = record.scores?.c ?? null;
      const tier = record.tiers?.c ?? LMS.tierFromScore(score);
      const card = LMS.h("div", "lucia-ms-card");
      const head = LMS.h("div", "lucia-ms-cardhead");
      const badge = LMS.h("span", "lucia-ms-badge", LMS.fmtScore(score));
      badge.style.background = LMS.tierColor(tier);
      head.append(LMS.h("b", null, rec.name), badge, LMS.h("em", null, `County ${rec.geoid} · Tier ${tier ?? "—"} · ${LMS.tierBand(tier)}`));
      card.appendChild(head);
      card.append(
        LMS.kv("Median home value", LMS.fmtMoney(rec.hval001c1)),
        LMS.kv("Median rent", LMS.fmtRent(rec.hou002c1)),
        LMS.kv("Poverty rate", LMS.fmtPct(rec.pov001c1)),
        LMS.kv("Vacancy rate", LMS.fmtPct(rec.hou005c1))
      );
      body.appendChild(card);

      if (bbl && pluto) {
        const lots = Array.isArray(pluto) ? pluto : pluto.parcels ?? [];
        const lot = lots.find((l) => String(l.bbl ?? l.BBL ?? "") === bbl);
        const lotBox = LMS.h("div", "lucia-ms-card");
        lotBox.appendChild(LMS.h("h3", null, `PLUTO lot ${bbl}`));
        if (lot) {
          lotBox.append(
            LMS.kv("Address", lot.address ?? lot.Address ?? "—"),
            LMS.kv("Building class", lot.bldgclass ?? lot.bldg_class ?? "—"),
            LMS.kv("Year built", lot.yearbuilt ?? lot.year_built ?? "—"),
            LMS.kv("Units (residential)", LMS.fmtInt(lot.unitsres ?? lot.units_res)),
            LMS.kv("Lot area (sq ft)", LMS.fmtInt(lot.lotarea ?? lot.lot_area))
          );
        } else {
          lotBox.appendChild(LMS.note("This BBL is not in the shipped PLUTO extract."));
        }
        body.appendChild(lotBox);
      }
    } catch (error) {
      if (!section.isConnected) return;
      body.replaceChildren(LMS.errorBox("Parcel context failed to load", error));
      console.warn("[market-stadium] dossier attachment failed:", error);
    }
  }

  LMS.dossier = { enhance, queueEnhance };
})();
