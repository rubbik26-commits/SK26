/* =============================================================================
   SKYLINE PROPERTIES — PRODUCT NAME + OWNERSHIP IDENTITY
   =============================================================================

   The compiled bundle is checksum-pinned, so the original product name,
   original deployment URL and original default report author remain inside the
   immutable production bytes. This ownership shell leaves those bytes and the
   application structure untouched, then applies only Skyline identity at the
   presentation boundary.

   That boundary includes more than the visible React tree. The original bundle
   also creates print/report windows with document.write() and owner-only
   Obsidian notes with Blob(). Those outputs bypass a MutationObserver on the
   main document, so they must be branded at creation time or a Skyline Owner
   can still download/client-send material labeled "NYC RE Market Intel".

   WHAT THIS FILE MAY CHANGE
     · Exact legacy product-name text -> Skyline Properties.
     · Exact legacy deployment URL -> the current deployment origin/host.
     · Exact legacy default report author -> Robert Khodadadian.
     · The exact legacy logo aria-label -> Skyline Properties logo.
     · localStorage["ndi_user"] only when absent or still the compiled legacy
       author "William Lockley"; an edited/signed-in identity always wins.

   WHAT IT DOES NOT CHANGE
     · No bundle byte, route, API call, calculation, element structure, control,
       layout, visibility rule, application state, setup instruction, integration
       wording or non-branding copy.
     · No arbitrary URLs or text. Every rewrite is an exact legacy identity
       literal.
     · No binary Blob. Only text/html and text/markdown generated deliverables
       are eligible for textual branding.
   ========================================================================== */

(function () {
  "use strict";

  var BRAND = "Skyline Properties";
  var BRAND_UPPER = "SKYLINE PROPERTIES";
  var OWNER_NAME = "Robert Khodadadian";
  var REPORT_IDENTITY_KEY = "ndi_user";
  var LEGACY_REPORT_AUTHOR = "William Lockley";
  var LEGACY_ORIGIN = "https://nycremarketintel.com";
  var LEGACY_HOST = "nycremarketintel.com";
  var CURRENT_ORIGIN = (typeof window !== "undefined" && window.location && window.location.origin) || LEGACY_ORIGIN;
  var CURRENT_HOST = (function () {
    try { return new URL(CURRENT_ORIGIN).host || LEGACY_HOST; } catch (e) { return LEGACY_HOST; }
  })();

  /* Ordered longest-first so a longer form is never left half-replaced. */
  var PRODUCT_RENAMES = [
    [/NYC RE Market Intel/g, BRAND],
    [/NYC Dev Intelligence/g, BRAND],
    [/NYC DEV INTELLIGENCE/g, BRAND_UPPER]
  ];
  var MAIN_MATCH = /NYC (?:RE Market Intel|Dev Intelligence|DEV INTELLIGENCE)|nycremarketintel\.com|William Lockley/;
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, NOSCRIPT: 1, TITLE: 1 };

  function brandProductText(value) {
    var next = String(value == null ? "" : value);
    for (var i = 0; i < PRODUCT_RENAMES.length; i++) next = next.replace(PRODUCT_RENAMES[i][0], PRODUCT_RENAMES[i][1]);
    return next;
  }

  function brandIdentityText(value) {
    var next = brandProductText(value);
    next = next.split(LEGACY_ORIGIN).join(CURRENT_ORIGIN);
    next = next.split(LEGACY_HOST).join(CURRENT_HOST);
    next = next.split(LEGACY_REPORT_AUTHOR).join(OWNER_NAME);
    return next;
  }

  function seedOwnerIdentity() {
    try {
      var existing = localStorage.getItem(REPORT_IDENTITY_KEY);
      if (!existing || existing === LEGACY_REPORT_AUTHOR) {
        localStorage.setItem(REPORT_IDENTITY_KEY, OWNER_NAME);
      }
    } catch (e) { /* storage may be unavailable; signed-in profile still works */ }
  }

  function renameMainDocument() {
    if (!document.body || !document.createTreeWalker) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentNode;
        if (!p || SKIP[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest("[contenteditable]")) return NodeFilter.FILTER_REJECT;
        return MAIN_MATCH.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    /* Collect first, then write: mutating during the walk would invalidate it. */
    var pending = [], node;
    while ((node = walker.nextNode())) pending.push(node);

    for (var i = 0; i < pending.length; i++) {
      var next = brandIdentityText(pending[i].nodeValue);
      if (next !== pending[i].nodeValue) pending[i].nodeValue = next;
    }

    // The bundle's SVG logo exposes the legacy name only through an aria-label,
    // so a text-node walker cannot reach it. Change that one exact accessibility
    // literal and no other attribute.
    try {
      var logos = document.querySelectorAll('[aria-label="NYC Dev Intelligence logo"],[aria-label="NYC RE Market Intel logo"]');
      for (var j = 0; j < logos.length; j++) logos[j].setAttribute("aria-label", BRAND + " logo");
    } catch (e) { /* branding must never break the application */ }
  }

  function brandGeneratedDocument(doc) {
    if (!doc || doc.__skylineBrandWritePatched) return;
    try { doc.__skylineBrandWritePatched = true; } catch (e) { return; }

    ["write", "writeln"].forEach(function (method) {
      var original = doc[method];
      if (typeof original !== "function") return;
      doc[method] = function () {
        var args = Array.prototype.map.call(arguments, function (part) {
          return typeof part === "string" ? brandIdentityText(part) : part;
        });
        return original.apply(doc, args);
      };
    });
  }

  function installGeneratedWindowBranding() {
    if (typeof window === "undefined" || typeof window.open !== "function" || window.__skylineOpenPatched) return;
    var originalOpen = window.open;
    window.open = function () {
      var child = originalOpen.apply(window, arguments);
      // Generated reports open an empty/about:blank window and then write the
      // document. External navigation windows are never modified.
      var target = arguments.length ? String(arguments[0] == null ? "" : arguments[0]) : "";
      if (child && (!target || target === "about:blank")) {
        try { brandGeneratedDocument(child.document); } catch (e) { /* popup may be blocked */ }
      }
      return child;
    };
    try { window.__skylineOpenPatched = true; } catch (e) {}
  }

  function installGeneratedBlobBranding() {
    if (typeof window === "undefined" || typeof window.Blob !== "function" || window.__skylineBlobPatched) return;
    var NativeBlob = window.Blob;

    function SkylineBlob(parts, options) {
      var type = String(options && options.type || "").toLowerCase().split(";", 1)[0].trim();
      var textual = type === "text/markdown" || type === "text/html";
      var nextParts = parts;
      if (textual && parts && typeof parts.length === "number") {
        nextParts = Array.prototype.map.call(parts, function (part) {
          return typeof part === "string" ? brandIdentityText(part) : part;
        });
      }
      return new NativeBlob(nextParts, options);
    }

    try { Object.setPrototypeOf(SkylineBlob, NativeBlob); } catch (e) {}
    SkylineBlob.prototype = NativeBlob.prototype;
    window.Blob = SkylineBlob;
    try { window.__skylineBlobPatched = true; } catch (e) {}
  }

  function apply() {
    try { seedOwnerIdentity(); } catch (e) { /* ownership identity must never break the app */ }
    try { renameMainDocument(); } catch (e) { /* branding must never break the application */ }
  }

  /* Install output hooks once. They only act later when the original bundle
     creates a blank generated document or a textual owner deliverable. */
  try { installGeneratedWindowBranding(); } catch (e) {}
  try { installGeneratedBlobBranding(); } catch (e) {}

  /* React remounts visible nodes as routes change. One coalesced pass per frame
     keeps this off the hot path of any render. */
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; apply(); });
  }

  function start() {
    apply();
    try {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* without MutationObserver the first pass still lands */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();