// Reconstruct the exact, immutable production frontend from the committed
// chunk set — no network, ever. server/data/production-frontend/ holds the
// complete brotli+base64 encoding of the compiled bundle; this script decodes
// it, verifies every byte against the pinned SHA-256, and writes the assets to
// public/assets/ under their immutable Vite filenames. Any missing part or
// checksum mismatch is a hard build failure: the deploy must fail fast rather
// than reach for a legacy origin or serve an approximation.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chunkDir = path.join(root, "server", "data", "production-frontend");
const outDir = path.join(root, "public", "assets");
mkdirSync(outDir, { recursive: true });

const SPECS = {
  "index-BbnE3o5g.js": "4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8",
  "index-shmfCHKD.css": "d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b"
};
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

export function reconstructAsset(name) {
  const expected = SPECS[name];
  if (!expected) throw new Error(`Unknown production asset: ${name}`);
  const parts = readdirSync(chunkDir)
    .filter((f) => f.startsWith(`${name}.part-`) && f.endsWith(".b64"))
    .sort();
  if (!parts.length) throw new Error(`${name}: no chunk parts found in server/data/production-frontend/`);
  const encoded = parts
    .map((part) => readFileSync(path.join(chunkDir, part), "utf8"))
    .join("")
    .replace(/\s+/g, "");
  let exact;
  try {
    exact = brotliDecompressSync(Buffer.from(encoded, "base64"));
  } catch (e) {
    throw new Error(`${name}: chunk set is incomplete or corrupt (${e?.message || e})`);
  }
  const actual = sha(exact);
  if (actual !== expected) throw new Error(`${name}: checksum mismatch (${actual} != ${expected})`);
  return exact;
}

export function reconstructAll() {
  let failed = 0;
  for (const [name, expected] of Object.entries(SPECS)) {
    const target = path.join(outDir, name);
    try {
      if (existsSync(target) && sha(readFileSync(target)) === expected) {
        console.log(`[reconstruct] ${name}: exact asset already in place (sha256 ${expected})`);
        continue;
      }
      const exact = reconstructAsset(name);
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, exact);
      renameSync(tmp, target);
      console.log(`[reconstruct] ${name}: rebuilt ${exact.length} exact bytes from committed chunks (sha256 ${expected})`);
    } catch (e) {
      failed += 1;
      console.error(`[reconstruct] ${name}: FAILED — ${e?.message || e}`);
    }
  }
  return failed;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const failed = reconstructAll();
  if (failed) {
    console.error("[reconstruct] the immutable production frontend could not be reconstructed; failing the build.");
    process.exit(1);
  }
  console.log("[reconstruct] exact production frontend verified in public/assets/.");
}
