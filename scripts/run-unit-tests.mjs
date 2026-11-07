// Run each unit/integration test file under the product variant it actually
// describes. The reconstruction target is Owner, so Owner is the default.
// api-parity and reported-defects retain historical reduced-member/two-password
// contracts; dedicated owner-* suites prove the full Owner deployment itself.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests");
const reducedUserSuites = new Set([
  "api-parity.test.mjs",
  "reported-defects.test.mjs"
]);
const discovered = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

// package.json passes tests/*.test.mjs so the command itself visibly promises
// full coverage. Shell expansion and directory discovery must agree; if a
// platform ever stops expanding the glob or a file is omitted, fail rather
// than quietly shrinking the gate. Direct invocation without arguments still
// discovers the complete suite.
const requested = process.argv.slice(2)
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => path.basename(name))
  .sort();
if (requested.length) {
  const expected = JSON.stringify(discovered);
  const actual = JSON.stringify([...new Set(requested)]);
  if (actual !== expected) {
    console.error("[unit-tests] FATAL: requested test set does not match tests/*.test.mjs discovery");
    console.error(`[unit-tests] discovered ${discovered.length}, requested ${requested.length}`);
    process.exit(2);
  }
}
const files = discovered;

let failures = 0;
for (const file of files) {
  const reducedUser = reducedUserSuites.has(file);
  const variant = reducedUser ? "user" : "owner";
  process.stdout.write(`\n===== ${file} [APP_VARIANT=${variant}] =====\n`);

  const env = { ...process.env, APP_VARIANT: variant };
  // The reduced-user suites deliberately exercise the self-hosted/local
  // compatibility account surface under NODE_ENV=development. Render's Owner
  // production blueprint correctly pins DISABLE_LOCAL_SQLITE=1, but allowing
  // that deployment-only safety switch to leak into these compatibility tests
  // makes signup/magic-link assertions fail with "local store unavailable"
  // before the behavior under test is reached. Keep first-user elevation off;
  // only re-enable the local test store itself.
  if (reducedUser) {
    env.DISABLE_LOCAL_SQLITE = "0";
    env.LOCAL_FIRST_USER_OWNER = "0";
  }

  const r = spawnSync(process.execPath, ["--test", path.join("tests", file)], {
    cwd: root,
    env,
    stdio: "inherit"
  });
  if (r.status !== 0) failures += 1;
}

process.stdout.write(`\n===== unit suite =====\n${files.length - failures}/${files.length} files passed; ${failures} file failure(s)\n`);
process.exit(failures ? 1 : 0);
