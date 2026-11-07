// Static reachability proof for the synthetic generators (P7.4, P7.5).
//
// The question is not "does a generator exist" — one does, deliberately, for
// offline and demo work. The question is whether any production route entry
// point can reach it. This walks the import graph from every module server.js
// mounts, and reports the shortest path from each entry point to any module
// that can invent property facts.
//
//   node scripts/synthetic-reachability.mjs
// Exits non-zero if a production route can reach a synthetic generator.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Modules that can produce property facts that are not in a public record.
const SYNTHETIC = new Set(["server/citymodel.js", "server/seed-parcels.js"]);

// Mounted in server.js AFTER the live guard, and reachable only when a live
// pull has already failed and the guard has converted that into a 503 for
// every authoritative path. It is the demo tier, not a production route.
const DEMO_TIER = new Set(["server/routes.js"]);

function importsOf(rel) {
  const file = path.join(root, rel);
  if (!existsSync(file)) return [];
  const src = readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+"(\.\/[^"]+|\.\.\/[^"]+)"/g)) {
    out.push(path.join(path.dirname(rel), m[1]).replace(/\\/g, "/"));
  }
  for (const m of src.matchAll(/import\(\s*"(\.\/[^"]+|\.\.\/[^"]+)"\s*\)/g)) {
    out.push(path.join(path.dirname(rel), m[1]).replace(/\\/g, "/"));
  }
  return out;
}

// Every router server.js mounts, in mount order.
function mountedRouters() {
  const src = readFileSync(path.join(root, "server.js"), "utf8");
  const byName = new Map();
  for (const m of src.matchAll(/import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+"(\.\/server\/[^"]+)"/g)) {
    const [, def, named, file] = m;
    const rel = file.replace("./", "");
    if (def) byName.set(def, rel);
    for (const n of (named || "").split(",").map((x) => x.trim().split(" as ").pop()).filter(Boolean)) byName.set(n, rel);
  }
  const mounted = [];
  for (const m of src.matchAll(/app\.use\(\s*([A-Za-z0-9_]+)\s*[),]/g)) {
    const rel = byName.get(m[1]);
    if (rel && !mounted.includes(rel)) mounted.push(rel);
  }
  return mounted;
}

function pathTo(start, targets) {
  const queue = [[start, [start]]];
  const seen = new Set([start]);
  while (queue.length) {
    const [node, trail] = queue.shift();
    if (targets.has(node) && trail.length > 1) return trail;
    for (const next of importsOf(node)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([next, [...trail, next]]);
    }
  }
  return null;
}

const routers = mountedRouters();
const reachable = [];
for (const rel of routers) {
  const trail = pathTo(rel, SYNTHETIC);
  if (trail) reachable.push({ router: rel, trail });
}

console.log(`mounted routers: ${routers.length}`);
for (const rel of routers) {
  const hit = reachable.find((r) => r.router === rel);
  const tier = DEMO_TIER.has(rel) ? " [demo tier, behind the live guard]" : "";
  console.log(`  ${hit ? "REACHES" : "clean  "}  ${rel}${tier}`);
  if (hit) console.log(`             ${hit.trail.join(" -> ")}`);
}

// Reachability alone is not the defect: the demo tier is meant to reach these
// modules, and a production router may legitimately import one as a fallback.
// What must hold is that every entry point INTO a generator is guarded, so a
// production request cannot get an answer out of it. Verify the guard is
// present on each exported function that can produce a property fact.
const UNGUARDED_OK = new Set([
  // Pure lookup tables and label helpers — they invent nothing.
  "ALL_ZIPS", "landUseLabel", "distressSignals", "NEIGHBORHOODS", "CATEGORIES",
  "SIGNAL_TYPES", "BOROUGH_BY_NEIGHBORHOOD", "SEED_PARCELS", "findSeedByBbl", "NOW", "THIS_YEAR"
]);

const unguarded = [];
for (const rel of SYNTHETIC) {
  const src = readFileSync(path.join(root, rel), "utf8");
  for (const m of src.matchAll(/export function (\w+)\(([^)]*)\)\s*\{([\s\S]{0,200})/g)) {
    const [, name, , head] = m;
    if (UNGUARDED_OK.has(name)) continue;
    if (!head.includes("assertSyntheticAllowed")) unguarded.push(`${rel}:${name}`);
  }
}

console.log(`\nproduction routers that can reach a synthetic generator: ${reachable.filter((r) => !DEMO_TIER.has(r.router)).length}`);
for (const v of reachable.filter((r) => !DEMO_TIER.has(r.router))) console.log(`  ${v.trail.join(" -> ")}`);
console.log(`\nsynthetic generator exports without a production guard: ${unguarded.length}`);
for (const u of unguarded) console.log(`  ${u}`);
process.exit(unguarded.length ? 1 : 0);
