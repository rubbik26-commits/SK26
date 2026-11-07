// Regenerate the committed chunk encoding of the immutable production frontend.
// Reads the exact assets (public/assets or site/assets), verifies them against
// the pinned checksums, then writes the complete brotli+base64 chunk set to
// server/data/production-frontend/ plus a manifest. The chunk set is the
// repository's canonical, network-free source for the compiled bundle:
// scripts/reconstruct-frontend.js must always be able to rebuild the exact
// bytes from these parts alone.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chunkDir = path.join(root, "server", "data", "production-frontend");
mkdirSync(chunkDir, { recursive: true });

const SPECS = {
  "index-BbnE3o5g.js": "4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8",
  "index-shmfCHKD.css": "d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b"
};
const PART_CHARS = 20000;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function readExact(name, expected) {
  for (const dir of [path.join(root, "public", "assets"), path.join(root, "site", "assets")]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    if (sha(buf) === expected) return buf;
    console.error(`[chunks] ${file} exists but fails the pinned checksum — refusing to encode it.`);
  }
  return null;
}

let failed = 0;
const manifest = { generatedFrom: "exact vendored assets", partChars: PART_CHARS, assets: {} };
for (const [name, expected] of Object.entries(SPECS)) {
  const exact = readExact(name, expected);
  if (!exact) {
    console.error(`[chunks] ${name}: no exact source bytes available (checksum ${expected}).`);
    failed += 1;
    continue;
  }
  const encoded = brotliCompressSync(exact, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: exact.length
    }
  }).toString("base64");

  // Round-trip proof before a single byte is written.
  const roundTrip = brotliDecompressSync(Buffer.from(encoded, "base64"));
  if (sha(roundTrip) !== expected) {
    console.error(`[chunks] ${name}: round-trip verification failed — aborting.`);
    failed += 1;
    continue;
  }

  for (const stale of readdirSync(chunkDir).filter((f) => f.startsWith(`${name}.part-`) && f.endsWith(".b64"))) {
    unlinkSync(path.join(chunkDir, stale));
  }
  const parts = [];
  for (let i = 0; i * PART_CHARS < encoded.length; i += 1) {
    const part = `${name}.part-${String(i).padStart(3, "0")}.b64`;
    writeFileSync(path.join(chunkDir, part), encoded.slice(i * PART_CHARS, (i + 1) * PART_CHARS));
    parts.push(part);
  }
  manifest.assets[name] = { sha256: expected, bytes: exact.length, encodedChars: encoded.length, parts: parts.length };
  console.log(`[chunks] ${name}: ${parts.length} parts (${encoded.length} b64 chars for ${exact.length} exact bytes)`);
}
writeFileSync(path.join(chunkDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

if (failed) {
  console.error(`[chunks] ${failed} asset(s) could not be encoded.`);
  process.exit(1);
}
console.log("[chunks] complete chunk set written — reconstruct-frontend.js can now rebuild the exact bundle offline.");
