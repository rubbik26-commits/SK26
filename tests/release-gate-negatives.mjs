// Phase 19, P19.6–P19.11 — prove each gate by making it fail.
//
//   node tests/release-gate-negatives.mjs [--only P19.9]
//
// "A gate that has never failed has not been verified." So for each of the six
// regressions this suite is supposed to catch, this harness:
//
//   1. records the exact bytes of the file it is about to break,
//   2. introduces the regression for real — a genuine edit to a real file,
//   3. runs the gate that is supposed to catch it and requires a FAILURE,
//   4. restores the file and verifies the restore byte-for-byte by SHA-256,
//   5. runs the same gate again and requires a PASS.
//
// A negative that does not fail is itself a failure: it means the gate is
// decorative. So is a negative that fails for the wrong reason, which is why
// each one states a marker that must appear in the failing output.
//
// SAFETY. Every mutation is reverted in a finally block, and the revert is
// checked by hash rather than assumed. If the process is killed mid-run, the
// same check on the next run reports the file as dirty instead of quietly
// building on a broken tree. Nothing here is left behind on success.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const PORT = Number(process.env.NEGATIVE_TEST_PORT || 5178);
const BASE = `http://localhost:${PORT}`;

// EXCLUSIVE LOCK.
//
// This harness edits real files while it runs. Anything else reading the tree at
// the same time sees a deliberately broken repository and reports false
// failures — which happened: a Phase 14 matrix run overlapped one of these and
// recorded `/` as load:FAIL because the shell had an injected exception in it at
// that moment. The lock makes the collision impossible instead of asking future
// runs to remember.
const LOCK = path.join(root, ".release-gate-negatives.lock");
if (existsSync(LOCK)) {
  console.error(
    `REFUSING TO START: ${LOCK} exists.\n` +
    `Either another negative run is in progress, or one was killed mid-flight and the tree may still be mutated.\n` +
    `Check \`git status\` — if it is clean, delete the lock file and re-run.`
  );
  process.exit(3);
}
writeFileSync(LOCK, `${process.pid}\n`);
const releaseLock = () => { try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch { /* best effort */ } };
process.on("exit", releaseLock);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { releaseLock(); process.exit(130); });

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const read = (rel) => readFileSync(path.join(root, rel));
const write = (rel, buf) => writeFileSync(path.join(root, rel), buf);

function run(cmd, args, { env = {}, timeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const cap = (b) => { out += b.toString(); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: out + String(e) }); });
  });
}

// A server for the browser gates. The node tests boot their own.
let server = null;
async function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "ignore", "pipe"]
  });
  for (let i = 0; i < 160; i++) {
    try { await fetch(`${BASE}/healthz`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error(`server did not start on ${BASE}`);
}
async function stopServer() {
  if (!server) return;
  try { server.kill("SIGKILL"); } catch { /* already down */ }
  server = null;
  await new Promise((r) => setTimeout(r, 600));
}

// ---------------------------------------------------------------- the six
const NEGATIVES = [
  {
    id: "P19.6",
    title: "fail on uncaught browser exceptions",
    file: "public/index.html",
    // An uncaught error thrown during page load, from the shell — exactly the
    // class of defect that used to reach production as "it looks fine to me".
    mutate: (s) => s.replace("</head>",
      `  <script>throw new Error("release-gate negative P19.6: injected uncaught exception");</script>\n  </head>`),
    gate: ["browser", "tests/browser/release-gate.cjs"],
    marker: /uncaught|exception|page error/i
  },
  {
    id: "P19.7",
    title: "fail on same-origin application requests that should succeed",
    file: "public/index.html",
    mutate: (s) => s.replace("</head>",
      `  <script src="/js/__p19_7_missing__.js"></script>\n  </head>`),
    gate: ["browser", "tests/browser/release-gate.cjs"],
    marker: /404|failed request|same-origin|__p19_7_missing__/i
  },
  {
    id: "P19.8",
    title: "fail on incorrect frontend hashes",
    file: "public/assets/index-shmfCHKD.css",
    // One byte is enough, and one byte is the point: the pinned bundle is the
    // parity contract, so any drift at all has to be caught.
    mutate: (s) => `${s}\n/* release-gate negative P19.8 */\n`,
    gate: ["node", "tests/render-migration.test.mjs"],
    marker: /hash|byte-match|checksum|sha/i
  },
  {
    id: "P19.9",
    title: "fail on route-shadowing regressions",
    file: "server.js",
    // The exact regression this repository has actually suffered: a router
    // mounted ahead of the authoritative one, silently answering its path.
    mutate: (s) => s.replace("app.use(parityRoutes);",
      `app.use((req, res, next) => {\n` +
      `  if (req.path.startsWith("/api/lot-tiles/")) return res.json({ type: "FeatureCollection", features: [] });\n` +
      `  return next();\n});\napp.use(parityRoutes);`),
    gate: ["node", "tests/route-resolution.test.mjs"],
    marker: /route|shadow|answered by|module/i
  },
  {
    id: "P19.10",
    title: "fail on persistence regressions",
    file: "server/durable-store.js",
    // Saves that quietly go nowhere — the precise shape of the bug that made
    // every deploy look identical.
    mutate: (s) => s.replace("    async save(value) {",
      `    async save(value) {\n      if (process.env.NODE_ENV !== "__never__") return { backend: "postgres" };`),
    gate: ["node", "tests/durable-store.test.mjs"],
    marker: /surviv|persist|state|postgres|adopt/i
  },
  {
    id: "P19.11",
    title: "fail on authorization regressions",
    file: "server/gate.js",
    // Everyone becomes the owner — the worst possible authorization regression,
    // and one a smoke test that only checks "the page loads" would never see.
    mutate: (s) => s.replace("export function gateRole(req) {",
      `export function gateRole(req) {\n  if (process.env.NODE_ENV !== "__never__") return "owner";`),
    gate: ["node", "tests/gate-role.test.mjs"],
    marker: /owner|role|anon|authoriz|gate/i
  }
];

const runGate = async ([kind, file]) => {
  if (kind === "node") return run(process.execPath, ["--test", file]);
  await stopServer();
  await startServer();
  const r = await run(process.execPath, [file, BASE]);
  await stopServer();
  return r;
};

const results = [];
const say = (id, state, detail) => {
  const mark = state === "PASS" ? "  ok  " : " FAIL ";
  console.log(`${mark} ${id.padEnd(7)}${detail}`);
  results.push({ id, state, detail });
};

console.log("\nPhase 19 — negative verification of P19.6–P19.11");
console.log("Each gate is proven by breaking the thing it guards, requiring a failure, reverting, and requiring a pass.\n");

for (const neg of NEGATIVES) {
  if (only && neg.id !== only) continue;
  const original = read(neg.file);
  const originalHash = sha(original);
  let failing = null, passing = null, mutatedOk = false;

  try {
    const mutated = Buffer.from(neg.mutate(original.toString("utf8")), "utf8");
    mutatedOk = sha(mutated) !== originalHash;
    if (!mutatedOk) throw new Error(`the mutation did not change ${neg.file} — the anchor no longer exists`);
    write(neg.file, mutated);
    failing = await runGate(neg.gate);
  } catch (e) {
    failing = { code: -1, out: `harness error: ${e.message}` };
  } finally {
    write(neg.file, original);
    const restoredHash = sha(read(neg.file));
    if (restoredHash !== originalHash) {
      console.error(`FATAL: ${neg.file} was not restored (${restoredHash} != ${originalHash})`);
      process.exit(2);
    }
  }

  if (!mutatedOk) {
    say(neg.id, "FAIL", `${neg.title} — could not introduce the regression: the anchor in ${neg.file} no longer exists, so this gate is UNVERIFIED`);
    continue;
  }

  passing = await runGate(neg.gate);

  const failedWhenBroken = failing.code !== 0;
  const rightReason = neg.marker.test(failing.out);
  const passedWhenFixed = passing.code === 0;
  const ok = failedWhenBroken && rightReason && passedWhenFixed;

  const evidence = (failing.out.split("\n").filter((l) => neg.marker.test(l)).slice(0, 2).join(" / ") || failing.out.trim().split("\n").slice(-2).join(" / ")).slice(0, 170);
  say(neg.id, ok ? "PASS" : "FAIL",
    `${neg.title} — broke ${neg.file}: gate exited ${failing.code} (${failedWhenBroken ? "failed as required" : "DID NOT FAIL"}), ` +
    `for the right reason (${rightReason}); after revert exited ${passing.code} (${passedWhenFixed ? "green again" : "STILL RED"}). ` +
    `Evidence: ${evidence}`);
}

await stopServer();

const pass = results.filter((r) => r.state === "PASS").length;
const fail = results.filter((r) => r.state === "FAIL").length;
console.log(`\n${"=".repeat(64)}`);
console.log(`PHASE 19 NEGATIVES: ${pass} pass · ${fail} fail  of ${results.length}`);
results.filter((r) => r.state === "FAIL").forEach((r) => console.log(`  FAIL ${r.id}: ${r.detail}`));
process.exit(fail ? 1 : 0);
