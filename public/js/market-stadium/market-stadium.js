// Market Stadium shell layer — entry point.
//
// Loaded last. Adds one navigation entry to lucia's existing rail pointing at
// the mounted Market Stadium surface (/market/), and starts the in-lucia
// attachments. It touches no lucia data, formula, persistence or API contract:
// the rail entry is a link, and every attachment renders into an element this
// layer created itself.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.booted) return;
  LMS.booted = true;

  const RAIL_LINK_ATTR = "data-market-link";
  const HREF = "/market/";

  function railNavs() {
    // lucia's rail is the scrollable sidebar nav; the mobile bar is its
    // md:hidden twin. Both carry the same destinations.
    return [...document.querySelectorAll("nav")].filter((n) => n.querySelector("a"));
  }

  function injectRail() {
    for (const nav of railNavs()) {
      if (nav.querySelector(`[${RAIL_LINK_ATTR}]`)) continue;
      const template = nav.querySelector("a");
      if (!template) continue;

      const link = template.cloneNode(true);
      link.href = HREF;
      link.setAttribute(RAIL_LINK_ATTR, "1");
      link.removeAttribute("aria-current");
      link.classList.remove("active");

      // Replace the label text, keeping the icon and the template's structure.
      const label = link.querySelector("span") ?? link;
      const target = label === link ? link : label;
      const icon = link.querySelector("svg");
      target.textContent = "Market Stadium";
      if (icon && !link.contains(icon)) link.prepend(icon);

      nav.appendChild(link);
    }
  }

  function boot() {
    injectRail();
    // The rail is rendered by the pinned bundle after hydration; re-check on
    // DOM changes rather than assuming a single mount.
    const observer = new MutationObserver(() => injectRail());
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });

    for (const mod of [LMS.panels, LMS.panels2, LMS.panels3, LMS.dossier, LMS.territory, LMS.comps]) {
      if (mod && typeof mod.queueEnhance === "function") mod.queueEnhance();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
