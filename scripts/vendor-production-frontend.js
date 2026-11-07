// Build-time vendoring for the immutable production frontend supplied in
// nycremarketintel-site 2.zip. The large compiled assets are checksum pinned
// and every source is local to the repository: an already-vendored
// public/assets copy, the committed raw ZIP bytes at site/assets/, or the
// complete checksum-pinned brotli chunk set at server/data/production-frontend/.
// There is no network fallback — when no local source verifies, the build
// fails fast instead of reaching for a legacy origin.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "assets");
const chunkDir = path.join(root, "server", "data", "production-frontend");
mkdirSync(outDir, { recursive: true });

const SPECS = {
  "index-BbnE3o5g.js": "4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8",
  "index-shmfCHKD.css": "d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b"
};
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function bundledCandidate(name, expected) {
  if (!existsSync(chunkDir)) return null;
  const prefix = `${name}.part-`;
  const parts = readdirSync(chunkDir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".b64"))
    .sort();
  if (!parts.length) return null;

  try {
    const encoded = parts
      .map((part) => readFileSync(path.join(chunkDir, part), "utf8"))
      .join("")
      .replace(/\s+/g, "");
    const exact = brotliDecompressSync(Buffer.from(encoded, "base64"));
    const actual = sha(exact);
    if (actual !== expected) {
      console.warn(`[production-frontend] ${name}: bundled chunks rejected (checksum ${actual} != ${expected})`);
      return null;
    }
    return exact;
  } catch (e) {
    console.warn(`[production-frontend] ${name}: bundled chunks incomplete/unreadable (${e?.message || e})`);
    return null;
  }
}

let missing = 0;
for (const [name, expected] of Object.entries(SPECS)) {
  const target = path.join(outDir, name);
  if (existsSync(target)) {
    try {
      const local = readFileSync(target);
      if (sha(local) === expected) {
        console.log(`[production-frontend] ${name}: exact local asset already vendored`);
        continue;
      }
      console.warn(`[production-frontend] ${name}: removing/overwriting non-authoritative local bytes`);
    } catch { /* fall through to the hermetic sources */ }
  }

  // Hermetic sources only — the raw ZIP bytes committed at site/assets/, then
  // the checksum-pinned brotli chunks. Every source is accepted only on an
  // exact checksum match; no origin is ever contacted.
  let exact = null;
  let source = "";
  const committed = path.join(root, "site", "assets", name);
  if (existsSync(committed)) {
    try {
      const buf = readFileSync(committed);
      if (sha(buf) === expected) { exact = buf; source = "site/assets (committed ZIP bytes)"; }
      else console.warn(`[production-frontend] ${name}: committed copy failed checksum; trying chunks`);
    } catch { /* fall through */ }
  }
  if (!exact) {
    exact = bundledCandidate(name, expected);
    if (exact) source = "repository chunks";
  }

  if (!exact) {
    missing += 1;
    console.error(`[production-frontend] ${name}: no local source produced the exact bytes (checksum ${expected})`);
    continue;
  }
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, exact);
  renameSync(tmp, target);
  console.log(`[production-frontend] ${name}: vendored exact ZIP bytes from ${source}`);
}

if (missing) {
  // Fail fast: the app must never start a deploy that cannot serve the exact
  // production frontend from local bytes alone.
  console.error(`[production-frontend] ${missing} exact asset(s) unavailable from local sources — failing the build.`);
  process.exit(1);
}
console.log("[production-frontend] exact production frontend fully vendored (hermetic)");
