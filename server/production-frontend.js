// Exact production-frontend bridge.
//
// nycremarketintel-site 2.zip is the frontend authority. Only checksum-pinned
// bytes are ever served under its immutable Vite filenames, and every source is
// local to the repository: the vendored public/assets copy, the committed
// site/assets ZIP bytes, or the complete brotli+base64 chunk set under
// server/data/production-frontend/. There is no network fallback — if none of
// the local sources verifies against the pinned SHA-256, startup fails fast so
// a broken deploy can never lean on the legacy origin or serve a mismatched
// byte.
import { Router } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicAssetDir = path.join(rootDir, "public", "assets");
const siteAssetDir = path.join(rootDir, "site", "assets");
const chunkDir = path.join(__dirname, "data", "production-frontend");
mkdirSync(publicAssetDir, { recursive: true });
mkdirSync(chunkDir, { recursive: true });

const SPECS = {
  "index-BbnE3o5g.js": {
    sha256: "4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8",
    type: "text/javascript; charset=utf-8"
  },
  "index-shmfCHKD.css": {
    sha256: "d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b",
    type: "text/css; charset=utf-8"
  }
};

const memory = new Map();
const source = new Map();

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function verify(name, buf) {
  const expected = SPECS[name]?.sha256;
  if (!expected) throw new Error(`Unknown production asset: ${name}`);
  const actual = sha256(buf);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${name}: ${actual}`);
  return buf;
}
function atomicWrite(file, buf) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, file);
}
function tryFile(name, dir) {
  try {
    const file = path.join(dir, name);
    if (!existsSync(file)) return null;
    return verify(name, readFileSync(file));
  } catch { return null; }
}
function tryVendoredChunks(name) {
  try {
    const files = readdirSync(chunkDir)
      .filter((f) => f.startsWith(`${name}.part-`) && f.endsWith(".b64"))
      .sort();
    if (!files.length) return null;
    const encoded = files.map((f) => readFileSync(path.join(chunkDir, f), "utf8")).join("").replace(/\s+/g, "");
    const raw = brotliDecompressSync(Buffer.from(encoded, "base64"));
    return verify(name, raw);
  } catch { return null; }
}

function loadExact(name) {
  if (memory.has(name)) return memory.get(name);

  let raw = tryFile(name, publicAssetDir);
  let from = raw ? "vendored-public-asset" : "";
  if (!raw) {
    raw = tryFile(name, siteAssetDir);
    if (raw) from = "committed-zip-bytes";
  }
  if (!raw) {
    raw = tryVendoredChunks(name);
    if (raw) from = "vendored-zip-chunks";
  }
  if (!raw) {
    throw new Error(
      `${name}: no local source verified against sha256 ${SPECS[name].sha256}. ` +
      "Run `node scripts/reconstruct-frontend.js` — this deployment never fetches assets over the network."
    );
  }

  // Keep the verified bytes materialized in public/assets so express.static and
  // external hash checks see the same immutable file the router serves.
  const target = path.join(publicAssetDir, name);
  try {
    if (!existsSync(target) || sha256(readFileSync(target)) !== SPECS[name].sha256) atomicWrite(target, raw);
  } catch { /* serving continues from memory even if the write is refused */ }

  memory.set(name, raw);
  source.set(name, from);
  return raw;
}

// Startup guard: verify every immutable asset from local sources before the
// server accepts traffic. Throws (and the process exits) when any byte of the
// production frontend cannot be produced locally.
export function ensureExactAssets() {
  for (const name of Object.keys(SPECS)) loadExact(name);
  return Object.fromEntries(Object.keys(SPECS).map((name) => [name, source.get(name)]));
}

const router = Router();
for (const [name, spec] of Object.entries(SPECS)) {
  router.get(`/assets/${name}`, (_req, res) => {
    try {
      const raw = loadExact(name);
      res.set("Content-Type", spec.type);
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.set("ETag", `\"sha256-${spec.sha256}\"`);
      res.send(raw);
    } catch (e) {
      res.status(503).type("text/plain").send(`Exact production frontend asset unavailable: ${e?.message || "unknown error"}`);
    }
  });
}

router.get("/api/frontend-parity", (_req, res) => {
  const assets = {};
  let exact = true;
  for (const name of Object.keys(SPECS)) {
    try {
      const raw = loadExact(name);
      assets[name] = {
        exact: sha256(raw) === SPECS[name].sha256,
        sha256: sha256(raw),
        expectedSha256: SPECS[name].sha256,
        source: source.get(name) || "memory"
      };
      if (!assets[name].exact) exact = false;
    } catch (e) {
      exact = false;
      assets[name] = { exact: false, expectedSha256: SPECS[name].sha256, error: e?.message || "unavailable" };
    }
  }
  res.status(exact ? 200 : 503).json({ exact, reference: "nycremarketintel-site 2.zip", assets });
});

export default router;
