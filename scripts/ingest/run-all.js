// Full sync orchestrator: MapPLUTO polygons → NTA polygons → ACRIS / DOB /
// violations / tax. A complete unbounded citywide run earns the PostGIS
// freshness certificate only after every required source succeeds and stale
// rows from the previous snapshot are reconciled away.
//
// Usage:
//   node scripts/ingest/run-all.js                    # complete + certify
//   node scripts/ingest/run-all.js --zips=10001      # scoped; no certificate
//   node scripts/ingest/run-all.js --limit=5000      # test cap; no certificate
import { randomUUID } from "node:crypto";
import { requireStore, args, rpc, heartbeatFullSync } from "./lib.js";
import { ingestMapPluto } from "./mappluto.js";
import { ingestNtas } from "./nta.js";
import { ingestAcris } from "./acris.js";
import { ingestDob } from "./dob.js";
import { ingestViolations } from "./violations.js";
import { ingestTax } from "./tax.js";

requireStore();
const a = args();
const t0 = Date.now();
const runStartedAt = new Date(t0).toISOString();

const scoped = Boolean(
  a.zips || a.borough || a.where || a.bbls || a.limit || a["skip-docs"]
);

// Internal run metadata is deliberately not derived by individual workers.
// Every phase sees the same strictness/snapshot ID, and MapPLUTO can pass the
// exact scoped BBL set to the document workers through this same object.
a.__strictComplete = !scoped;
a.__runStartedAt = runStartedAt;
a.__fullSyncId = !scoped ? randomUUID() : null;

const details = { runStartedAt, scoped, fullSyncId: a.__fullSyncId };
let leaseAcquired = false;
let primaryFailure = null;

async function main() {
  console.log(`[run-all] mode=${scoped ? "scoped/non-certifying" : "citywide/strict-certifying"}`);

  try {
    if (!scoped) {
      // Lease acquisition and prior-certificate invalidation happen in ONE
      // database transaction. A second citywide refresh cannot overlap this
      // snapshot, and production falls back to live NYC data before the first
      // warehouse mutation begins.
      console.log(`[run-all] acquiring full-ingest lease ${a.__fullSyncId} …`);
      const started = await rpc("begin_full_ingest", {
        p_full_sync_id: a.__fullSyncId
      });
      if (!started?.acquired || started?.fullSyncId !== a.__fullSyncId) {
        throw new Error(`Another full ingest is active: ${JSON.stringify(started)}`);
      }
      leaseAcquired = true;
      details.certificateInvalidated = true;
      details.leaseExpiresAt = started.expiresAt || null;
      await heartbeatFullSync(a, { force: true });
    }

    console.log("[run-all] MapPLUTO parcels …");
    const parcelCount = await ingestMapPluto(a);
    details.parcels = { count: parcelCount, ...(a.__mapPlutoMeta || {}) };

    console.log("[run-all] NTA polygons …");
    details.ntas = await ingestNtas(a);

    if (!a["skip-docs"]) {
      console.log("[run-all] ACRIS documents …");
      details.acris = await ingestAcris(a);
      console.log("[run-all] DOB filings …");
      details.dob = await ingestDob(a);
      console.log("[run-all] DOB/ECB + HPD violations …");
      details.violations = await ingestViolations(a);
      console.log("[run-all] DOF tax roll …");
      details.tax = await ingestTax(a);
    }

    if (!scoped) {
      // All source phases above completed successfully and every observed row
      // has this exact snapshot UUID. Renew immediately before destructive
      // reconciliation so an expired/lost lease can never delete current rows.
      await heartbeatFullSync(a, { force: true });
      console.log(`[run-all] reconciling warehouse to full snapshot ${a.__fullSyncId} …`);
      const reconciliation = await rpc("reconcile_full_public_record_store", {
        p_full_sync_id: a.__fullSyncId
      }, { timeoutMs: 10 * 60 * 1000 });
      if (!reconciliation?.ok || reconciliation?.fullSyncId !== a.__fullSyncId) {
        throw new Error(`Warehouse reconciliation failed: ${JSON.stringify(reconciliation)}`);
      }
      details.reconciliation = reconciliation;

      await heartbeatFullSync(a, { force: true });
      console.log("[run-all] certifying complete citywide PostGIS store …");
      const cert = await rpc("mark_full_ingest_complete", {
        p_scope: {
          kind: "citywide",
          bounded: false,
          reconciled: true,
          fullSyncId: a.__fullSyncId
        },
        p_details: { ...details, durationSeconds: Math.round((Date.now() - t0) / 1000) },
        p_full_documents: true
      });
      if (
        !cert?.fresh ||
        cert?.fullDocuments !== true ||
        cert?.schemaVersion !== "202608150005" ||
        cert?.scope?.fullSyncId !== a.__fullSyncId ||
        cert?.scope?.reconciled !== true
      ) {
        throw new Error(`PostGIS certification failed: ${JSON.stringify(cert)}`);
      }
      console.log(`[run-all] certificate fresh until ${cert.expiresAt}`);
    } else {
      console.log("[run-all] scoped/bounded run complete — NOT certifying the warehouse as citywide authoritative");
    }

    console.log(`[run-all] complete in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    primaryFailure = e;
    throw e;
  } finally {
    if (leaseAcquired) {
      try {
        const released = await rpc("release_full_ingest", { p_full_sync_id: a.__fullSyncId });
        if (!released?.released) throw new Error(`lease release was not acknowledged: ${JSON.stringify(released)}`);
        console.log(`[run-all] released full-ingest lease ${a.__fullSyncId}`);
      } catch (releaseError) {
        console.error(`[run-all] full-ingest lease release failed: ${releaseError?.message || releaseError}`);
        // If the data run itself succeeded, a release failure is still an
        // operational failure and should be visible. If the run already failed,
        // preserve that primary cause; the lease self-expires in the database.
        if (!primaryFailure) throw releaseError;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
