// Copies vendored browser libraries from node_modules into public/vendor
// so the frontend runs with zero build step. Run after `npm install`:
//   npm run vendor
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jobs = [
  { from: "node_modules/leaflet/dist/leaflet.js", to: "public/vendor/leaflet/leaflet.js" },
  { from: "node_modules/leaflet/dist/leaflet.css", to: "public/vendor/leaflet/leaflet.css" },
  { from: "node_modules/leaflet/dist/images", to: "public/vendor/leaflet/images" },
  { from: "node_modules/leaflet-rotate/dist/leaflet-rotate-src.js", to: "public/vendor/leaflet/leaflet-rotate.js" },
  { from: "node_modules/maplibre-gl/dist/maplibre-gl.js", to: "public/vendor/maplibre/maplibre-gl.js" },
  { from: "node_modules/maplibre-gl/dist/maplibre-gl.css", to: "public/vendor/maplibre/maplibre-gl.css" },
  { from: "node_modules/pdfjs-dist/build/pdf.min.mjs", to: "public/vendor/pdfjs/pdf.min.mjs" },
  { from: "node_modules/pdfjs-dist/build/pdf.worker.min.mjs", to: "public/vendor/pdfjs/pdf.worker.min.mjs" },
  { from: "node_modules/tesseract.js/dist/tesseract.min.js", to: "public/vendor/tesseract/tesseract.min.js" },
  { from: "node_modules/tesseract.js/dist/worker.min.js", to: "public/vendor/tesseract/worker.min.js" },
  { from: "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js", to: "public/vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js" },
  { from: "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js", to: "public/vendor/tesseract/core/tesseract-core-lstm.wasm.js" }
  // public/vendor/tesseract/lang/eng.traineddata.gz is fetched once from
  // tessdata.projectnaptha.com and committed — no runtime CDN dependency.
];

for (const { from, to } of jobs) {
  const src = join(root, from);
  const dest = join(root, to);
  if (!existsSync(src)) {
    console.error(`missing ${from} — run npm install first`);
    process.exitCode = 1;
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`vendored ${from} -> ${to}`);
}
