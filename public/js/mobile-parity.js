/* Deal Radar accepts a street address.
 *
 * The Deal Radar search resolves what you type to a set of ZIPs: it parses
 * 5-digit ZIPs, or matches a known neighbourhood name. A street address
 * ("88 Allen Street") matches neither, so the query that backs the page stays
 * disabled — no request is issued, no spinner, no error, the empty-state card
 * disappears and the page just sits there. Typing an address and pressing
 * "Scan area" therefore looks like the search button is dead.
 *
 * This resolves an address to its ZIP through the same NYC GeoSearch-backed
 * /api/address endpoint the parcel dossier uses, rewrites the field to that
 * ZIP and lets the page's own search run. Anything that already resolves —
 * ZIPs, neighbourhood names, borough names — is passed straight through
 * untouched, so the existing behaviour is unchanged.
 */
(function () {
  "use strict";

  var SCAN_LABEL = /^scan area$/i;
  var HAS_ZIP = /\b\d{5}\b/;
  // A house number followed by a street: "88 Allen St", "350-360 W 34th".
  var STREET_ADDRESS = /^\s*\d+[\d\-–]*\s+\S/;

  var resolving = false;

  function needsResolution(value) {
    var v = String(value || "").trim();
    if (!v || HAS_ZIP.test(v)) return false;
    return STREET_ADDRESS.test(v);
  }

  function setReactValue(el, value) {
    var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function scanInput() {
    var inputs = document.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      var ph = inputs[i].getAttribute("placeholder") || "";
      if (/neighborhood or zip/i.test(ph)) return inputs[i];
    }
    return null;
  }

  function scanButton() {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      if (SCAN_LABEL.test((buttons[i].textContent || "").trim())) return buttons[i];
    }
    return null;
  }

  function requestZip(query) {
    return fetch("/api/address?q=" + encodeURIComponent(query), { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        var rows = (body && body.buildings) || [];
        for (var i = 0; i < rows.length; i++) {
          var zip = rows[i] && rows[i].zip;
          if (zip && /^\d{5}$/.test(String(zip))) return String(zip);
        }
        return null;
      });
  }

  // The first lookup for an address that is not yet cached goes out to NYC
  // GeoSearch and can be slow enough to be dropped; one retry keeps a cold
  // address from looking like a dead search button.
  function zipForAddress(query) {
    return requestZip(query).catch(function () {
      return new Promise(function (resolve) { setTimeout(resolve, 600); })
        .then(function () { return requestZip(query); })
        .catch(function () { return null; });
    });
  }

  // Resolve, rewrite the field, then re-run the page's own search.
  function resolveThenScan(input, button) {
    var typed = String(input.value || "").trim();
    resolving = true;
    zipForAddress(typed).then(function (zip) {
      if (zip) setReactValue(input, zip);
      setTimeout(function () {
        resolving = false;
        var target = button || scanButton();
        // Nothing resolved: let the page run its own search on what was typed
        // so its own "couldn't scan this area" copy is what the reader sees.
        if (target) target.click();
      }, 0);
    });
  }

  function intercept(ev, button) {
    if (resolving) return;
    var input = scanInput();
    if (!input || !needsResolution(input.value)) return;
    ev.preventDefault();
    ev.stopPropagation();
    resolveThenScan(input, button);
  }

  document.addEventListener("click", function (ev) {
    var node = ev.target;
    var button = null;
    while (node && node !== document) {
      if (node.tagName === "BUTTON") { button = node; break; }
      node = node.parentNode;
    }
    if (!button || !SCAN_LABEL.test((button.textContent || "").trim())) return;
    intercept(ev, button);
  }, true);

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    var el = ev.target;
    if (!el || el.tagName !== "INPUT") return;
    if (!/neighborhood or zip/i.test(el.getAttribute("placeholder") || "")) return;
    intercept(ev, null);
  }, true);
})();
