// A real Postgres on a TCP port, with no Docker and no server to install.
//
//   node scripts/pglite-server.mjs [port] [dataDir]
//
// This exists so the persistence fix can be *proved* rather than asserted.
// server/durable-store.js keeps the deployment-wide kanban board and investor
// pool in Postgres because Render's free plan has no persistent disk; the claim
// that this survives a redeploy is only worth anything if someone can watch it
// survive one. PGlite is the genuine Postgres engine compiled to WASM, and
// pglite-socket puts it behind the real wire protocol, so the application
// connects to it with an ordinary connection string and exercises the same
// `pg` client, the same SQL and the same jsonb round-trip it will use in
// production.
//
//   node scripts/pglite-server.mjs 55432 /tmp/pgdata &
//   SUPABASE_DB_URL=postgresql://postgres@127.0.0.1:55432/postgres npm start
//
// Then write something, delete APP_DATA_DIR, restart, and read it back.
// tests/durable-store.test.mjs covers the same ground in-process; this is for
// end-to-end runs against the actual server.
//
// Development only. It is never imported by the application.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.argv[2] || 55432);
const dataDir = process.argv[3] || "./.pglite-data";

const db = await PGlite.create(dataDir);
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
console.log(`[pglite] listening on 127.0.0.1:${port}, data in ${dataDir}`);

const shutdown = async () => {
  try { await server.stop(); } catch { /* already down */ }
  try { await db.close(); } catch { /* already closed */ }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
