// Runtime write probe (P6.1, P6.2).
//
// A grep finds the writes someone wrote literally; it misses writes made
// through a helper, a driver, or a dependency. This patches the filesystem
// write surface and the SQLite driver before the app loads, so every path the
// process actually writes at runtime is recorded with the stack frame that
// caused it.
//
// Preload it and exercise the app:
//   node --import ./scripts/write-probe.mjs server.js
// The report is written on exit to WRITE_PROBE_OUT (default /tmp/write-probe.json).
import fs from "node:fs";
import fsp from "node:fs/promises";

const OUT = process.env.WRITE_PROBE_OUT || "/tmp/write-probe.json";
const writes = new Map(); // target -> { count, kind, callers:Set }

function record(kind, target, skip = 3) {
  const key = `${kind}:${String(target)}`;
  const entry = writes.get(key) || { kind, target: String(target), count: 0, callers: new Set() };
  entry.count += 1;
  const frames = String(new Error().stack || "").split("\n").slice(skip)
    .map((l) => l.trim())
    .filter((l) => /\/home\/user\/lucia\//.test(l) && !/write-probe\.mjs/.test(l));
  if (frames[0]) {
    const m = frames[0].match(/\/home\/user\/lucia\/([^\s)]+)/);
    if (m) entry.callers.add(m[1]);
  }
  writes.set(key, entry);
}

// An unpatched handle, captured before the patches below, so writing the
// report never records itself.
const rawWriteFileSync = fs.writeFileSync;

// --- filesystem -------------------------------------------------------------
for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "renameSync", "rename", "mkdirSync", "mkdir", "rmSync", "unlinkSync"]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function patched(target, ...rest) {
    // Directory creation is noise unless something is written into it.
    if (!/^mkdir/.test(name)) record(`fs.${name}`, target);
    return original.call(this, target, ...rest);
  };
}
for (const name of ["writeFile", "appendFile", "rename", "rm", "unlink"]) {
  const original = fsp[name];
  if (typeof original !== "function") continue;
  fsp[name] = function patched(target, ...rest) {
    record(`fsp.${name}`, target);
    return original.call(this, target, ...rest);
  };
}

// --- what actually changed on disk ------------------------------------------
// Patching the fs object cannot see a module that did
// `import { writeFileSync } from "node:fs"`: an ESM named import binds to the
// export before this file runs, and rebinding the property on the namespace
// object does not reach it. Watching the directories the app writes into
// records the write regardless of how it was made — which is what P6.1 asks
// for: an inventory of runtime writes, not of literal call sites.
const WATCH_DIRS = [
  process.env.APP_DATA_DIR,
  new URL("../server/data/", import.meta.url).pathname,
  new URL("../data/", import.meta.url).pathname
].filter(Boolean);

for (const dir of WATCH_DIRS) {
  try {
    if (!fs.existsSync(dir)) continue;
    const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      if (String(filename).endsWith(".tmp")) return; // the atomic-rename staging file
      record(`disk.${event}`, `${dir}${filename}`, 2);
    });
    if (watcher.unref) watcher.unref();
    process.stdout.write(`[WRITE-PROBE] watching ${dir}\n`);
  } catch (e) {
    process.stdout.write(`[WRITE-PROBE] cannot watch ${dir}: ${e && e.message}\n`);
  }
}

// --- node:sqlite ------------------------------------------------------------
// The store is opened lazily and may be absent entirely; patch on demand.
try {
  const sqlite = await import("node:sqlite");
  const Database = sqlite.DatabaseSync;
  if (Database) {
    const originalExec = Database.prototype.exec;
    const originalPrepare = Database.prototype.prepare;
    Database.prototype.exec = function patchedExec(sql, ...rest) {
      if (/\b(insert|update|delete|create|drop|alter)\b/i.test(String(sql))) record("sqlite.exec", String(sql).replace(/\s+/g, " ").slice(0, 120));
      return originalExec.call(this, sql, ...rest);
    };
    Database.prototype.prepare = function patchedPrepare(sql, ...rest) {
      const stmt = originalPrepare.call(this, sql, ...rest);
      if (/\b(insert|update|delete)\b/i.test(String(sql))) {
        const originalRun = stmt.run;
        stmt.run = function patchedRun(...args) {
          record("sqlite.run", String(sql).replace(/\s+/g, " ").slice(0, 120));
          return originalRun.apply(this, args);
        };
      }
      return stmt;
    };
  }
} catch { /* node:sqlite unavailable on this host — nothing to patch */ }

// Keep an unpatched handle so the report itself is never recorded, and so a
// dump still works if a later patch throws.

function dump(reason) {
  const rows = [...writes.values()]
    .map((e) => ({ kind: e.kind, target: e.target, count: e.count, callers: [...e.callers] }))
    .sort((a, b) => b.count - a.count);
  try {
    rawWriteFileSync(OUT, JSON.stringify({ reason, at: new Date().toISOString(), rows }, null, 2));
    process.stdout.write(`[WRITE-PROBE] ${rows.length} distinct write targets -> ${OUT} (${reason})\n`);
  } catch (e) {
    process.stdout.write(`[WRITE-PROBE] dump failed: ${e && e.message}\n`);
  }
}

// The report is also written on a timer, so a run that is killed without a
// clean signal still leaves evidence behind.
const interval = setInterval(() => dump("interval"), 5000);
if (interval.unref) interval.unref();

process.on("exit", () => dump("exit"));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { dump(sig); process.exit(0); });
}
