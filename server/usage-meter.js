// Durable-ish usage meter shared by production-facing imagery and status routes.
// The data directory can be moved onto a Render persistent disk by setting
// APP_DATA_DIR (recommended: /var/data/nyc-re-market-intel).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(__dirname, "data");
mkdirSync(APP_DATA_DIR, { recursive: true });

const file = path.join(APP_DATA_DIR, "usage-meters.json");
let queue = Promise.resolve();

function readAll() {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}; }
  catch { return {}; }
}
function atomicWrite(value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readUsage() {
  return readAll();
}

export function bumpUsage(kind, by = 1) {
  // Serialize writes so concurrent image requests cannot lose increments.
  queue = queue.then(() => {
    const all = readAll();
    const month = new Date().toISOString().slice(0, 7);
    all[month] = all[month] || {};
    all[month][kind] = Math.max(0, Number(all[month][kind] || 0) + Number(by || 0));
    atomicWrite(all);
  }).catch(() => {});
  return queue;
}
