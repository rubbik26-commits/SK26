// Publish the vendored pdf.js as window.pdfjsLib, so the calculator's document
// reader never reaches for a CDN.
//
// The bundle's reader begins with `window.pdfjsLib || (await Dj(cdnUrl))`, so
// the whole network path is skipped when this object already exists. It cannot
// be satisfied by the URL rewrite in /js/vendor-local.js: Dj() builds a CLASSIC
// script, and the vendored build (pdfjs-dist, ES module) can only be loaded with
// an import — which is precisely why the bundle's .mjs attempt fails in the
// first place and it falls back to a 3.x CDN copy.
//
// Loaded as a module with defer semantics, so it does not block first paint. The
// reader is only reachable after a user picks a file, which is far later than
// this resolves.
import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";

const LOCAL_WORKER = "/vendor/pdfjs/pdf.worker.min.mjs";

try {
  const opts = pdfjsLib.GlobalWorkerOptions;
  if (opts) {
    // Immediately after loading the library the bundle does:
    //   window.pdfjsLib?.GlobalWorkerOptions &&
    //     (GlobalWorkerOptions.workerSrc = "https://cdnjs.../pdf.worker.min.js")
    // which would send the worker back to the network — and to a 3.x worker
    // against a 6.x library, which does not match. The property is therefore
    // defined with a setter that keeps a local path and ignores CDN ones, while
    // still honouring any other value a caller sets deliberately.
    let current = LOCAL_WORKER;
    Object.defineProperty(opts, "workerSrc", {
      configurable: true,
      enumerable: true,
      get() { return current; },
      set(value) {
        const v = String(value || "");
        const external = /^https?:\/\//i.test(v) && !v.startsWith(location.origin);
        current = external ? LOCAL_WORKER : (v || LOCAL_WORKER);
      }
    });
    opts.workerSrc = LOCAL_WORKER;
  }
  window.pdfjsLib = pdfjsLib;
  console.info("[pdf-local] pdfjsLib served from /vendor/pdfjs — no CDN needed");
} catch (e) {
  // Deliberately loud. If this fails the reader silently falls back to the CDN,
  // and a silent fallback is the thing worth knowing about.
  console.error("[pdf-local] could not publish the vendored pdf.js:", e);
}
