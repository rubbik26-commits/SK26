/* Market Stadium bridge.
 *
 * The served shell is the immutable compiled bundle, so the link into the
 * Market Stadium surface is added here rather than by editing those bytes.
 * It appends one entry to the existing rail navigation and nothing else:
 * no data, no formulas, no API contract is touched.
 */
(function () {
  var HREF = "/market/";
  function inject() {
    if (document.querySelector("[data-market-link]")) return true;
    var rail = document.querySelector(".rail-nav") || document.querySelector("nav");
    if (!rail) return false;
    var a = document.createElement("a");
    a.href = HREF;
    a.setAttribute("data-market-link", "1");
    a.className = "rail-link";
    a.style.cssText = "display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;font-size:13px;color:inherit;text-decoration:none;opacity:.92";
    a.innerHTML = '<span style="width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8">' +
      '<path d="M3 20V9l6-4 6 4v11"/><path d="M15 20V12h6v8"/><path d="M3 20h18"/></svg></span>' +
      '<span>Market Stadium</span>';
    var sect = document.createElement("div");
    sect.className = "sect";
    sect.textContent = "Market intelligence";
    rail.appendChild(sect);
    rail.appendChild(a);
    return true;
  }
  if (!inject()) {
    var tries = 0;
    var t = setInterval(function () {
      if (inject() || ++tries > 40) clearInterval(t);
    }, 250);
  }
})();
