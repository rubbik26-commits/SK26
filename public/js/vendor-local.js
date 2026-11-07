// Serve the libraries the compiled bundle wants from this origin, not a CDN.
//
// WHAT THE BUNDLE DOES
// The document reader in the Deal Calculator loads its dependencies by building
// a <script> element at runtime:
//
//   function Dj(e){ const n = document.createElement("script");
//                   n.src = e; document.head.appendChild(n); ... }
//
//   window.pdfjsLib  || await Dj("https://cdnjs.cloudflare.com/.../pdf.min.mjs")
//                       .catch(() => Dj("https://cdnjs.cloudflare.com/.../pdf.min.js"))
//   window.Tesseract || await Dj("https://cdnjs.cloudflare.com/.../tesseract.min.js")
//
// and 3D City pulls MapLibre from unpkg the same way.
//
// WHY THAT IS WORTH REPLACING
// Three reasons, in order of how much they matter here:
//   1. This is a private, password-gated site. Every PDF a broker drops on the
//      calculator currently causes the browser to announce itself to a third
//      party before the file is read.
//   2. If cdnjs is slow, blocked by a corporate network, or down, "upload a
//      rent roll" silently stops working and the only signal is
//      "Couldn't read figures automatically".
//   3. The libraries are already vendored into public/vendor by
//      scripts/vendor.js and shipped in the image — they were simply never
//      wired up, so the deployment paid for a CDN it did not need.
//
// HOW
// The bundle is immutable, so nothing here edits it. Two hooks, both in this
// shell, both before the bundle runs:
//
//   * appendChild/insertBefore on <head> rewrite a known CDN script URL to its
//     local equivalent. That covers Tesseract and MapLibre, whose vendored
//     copies are the same classic-script format the loader expects.
//
//   * pdf.js cannot go through that path: the vendored build is an ES module
//     and Dj() creates a classic script, which is exactly why the .mjs attempt
//     fails and the loader falls back to the 3.x CDN copy. It is handled in
//     /js/pdf-local.js instead, which imports the module and publishes
//     window.pdfjsLib — the bundle checks `window.pdfjsLib ||` first, so once
//     that exists it never reaches for the network at all.
//
// If a URL is not recognised it is left completely alone: this redirects known
// libraries, it does not police the page.
(function () {
  "use strict";

  var MAP = [
    // pdf.js — see /js/pdf-local.js. Listed so a fallback attempt still lands
    // locally rather than on cdnjs, even though it should never be reached.
    [/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/[\d.]+\/pdf\.min\.mjs/i, "/vendor/pdfjs/pdf.min.mjs"],
    [/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/[\d.]+\/pdf\.worker\.min\.mjs/i, "/vendor/pdfjs/pdf.worker.min.mjs"],
    // Tesseract — OCR fallback for scanned rent rolls. Vendored copy is UMD,
    // the same shape the loader expects.
    [/cdnjs\.cloudflare\.com\/ajax\/libs\/tesseract\.js\/[\d.]+\/tesseract\.min\.js/i, "/vendor/tesseract/tesseract.min.js"],
    [/cdnjs\.cloudflare\.com\/ajax\/libs\/tesseract\.js\/[\d.]+\/worker\.min\.js/i, "/vendor/tesseract/worker.min.js"],
    // MapLibre — the 3D City surface.
    [/unpkg\.com\/maplibre-gl@[\d.]+\/dist\/maplibre-gl\.js/i, "/vendor/maplibre/maplibre-gl.js"],
    [/unpkg\.com\/maplibre-gl@[\d.]+\/dist\/maplibre-gl\.css/i, "/vendor/maplibre/maplibre-gl.css"]
  ];

  function localFor(url) {
    var s = String(url || "");
    for (var i = 0; i < MAP.length; i++) if (MAP[i][0].test(s)) return MAP[i][1];
    return null;
  }

  function rewrite(node) {
    if (!node || node.nodeType !== 1) return;
    var tag = node.tagName;
    if (tag !== "SCRIPT" && tag !== "LINK") return;
    var attr = tag === "SCRIPT" ? "src" : "href";
    var url = node.getAttribute(attr);
    var local = localFor(url);
    if (!local) return;
    node.setAttribute(attr, local);
    // The vendored pdf.js is a module; if anything ever does route here, say so
    // rather than letting it fail as a classic script.
    if (tag === "SCRIPT" && /\.mjs($|\?)/.test(local)) node.type = "module";
    try {
      console.info("[vendor-local] " + url + " -> " + local);
    } catch (e) { /* console may be unavailable */ }
  }

  ["appendChild", "insertBefore", "append", "prepend"].forEach(function (m) {
    var proto = Node.prototype[m] ? Node.prototype : Element.prototype;
    var original = proto[m];
    if (typeof original !== "function") return;
    proto[m] = function () {
      for (var i = 0; i < arguments.length; i++) rewrite(arguments[i]);
      return original.apply(this, arguments);
    };
  });

  // pdf.js starts its worker with `new Worker(GlobalWorkerOptions.workerSrc)`.
  // The bundle assigns that a cdnjs URL unconditionally after loading, so the
  // constructor is guarded too — otherwise the library would load locally and
  // then fetch its worker from the network anyway.
  var NativeWorker = window.Worker;
  if (typeof NativeWorker === "function") {
    var Patched = function (url, opts) {
      var local = localFor(url);
      if (local) {
        try { console.info("[vendor-local] worker " + url + " -> " + local); } catch (e) {}
        return new NativeWorker(local, /\.mjs($|\?)/.test(local) ? { type: "module" } : opts);
      }
      return new NativeWorker(url, opts);
    };
    Patched.prototype = NativeWorker.prototype;
    window.Worker = Patched;
  }
})();
