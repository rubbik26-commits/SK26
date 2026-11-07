// Market Stadium shell layer — address geocoder.
//
// The Census geocoder sends no CORS header, so the browser cannot call it
// directly. This resolves a typed address through the server proxy
// (/api/market/geocode) and returns the geography identifiers the layer needs
// to select a place. It never invents a match: an unresolved address returns
// { matched: false } and the caller says so.
(() => {
  const LMS = window.LuciaMarketStadium;
  if (!LMS || LMS.geocoder) return;

  const cache = new Map();

  async function resolve(query) {
    const q = String(query ?? "").trim();
    if (!q) return { matched: false, query: q, reason: "empty" };
    if (cache.has(q)) return cache.get(q);

    const result = await LMS.api.json(`/api/market/geocode?q=${encodeURIComponent(q)}`);
    cache.set(q, result);
    return result;
  }

  /** Pick the most specific level the geocoder resolved, and select it. */
  function apply(result) {
    if (!result?.matched) return null;
    for (const level of ["tract", "zipcode", "county", "cbsa"]) {
      const hit = result[level];
      if (hit?.geoid) {
        LMS.state.level = level;
        LMS.state.sel[level] = hit.geoid;
        return { level, geoid: hit.geoid, name: hit.name };
      }
    }
    return null;
  }

  LMS.geocoder = { resolve, apply };
})();
