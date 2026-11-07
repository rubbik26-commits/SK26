# Runtime write inventory — current authority-release state

This document replaces the 2026-08-13 inventory that described gate-only Pipeline and Investors as JSON-file persistence. That was true of the earlier compatibility router and is no longer the production write path.

## Current production ownership

| Surface | Current production owner | Durable authority | Ephemeral disk role | Redeploy posture |
|---|---|---|---|---|
| Gate-only Pipeline / CRM | `server/authority-release.js` | `durableStore("kanban-pipeline.json")` → direct Postgres, validated privileged PostgREST, or registered token RPC | local snapshot/cache only; a production save is rejected if no durable backend accepts it | Designed to survive redeploy |
| Gate-owner Investors | `server/authority-release.js` | `durableStore("investors-pool.json")` → same durable backend chain | local snapshot/cache only; production write fails closed when durability is unavailable | Designed to survive redeploy |
| Signed-in Pipeline | `server/authority-release.js` | Supabase `cre_pipeline`, scoped to the authenticated user | none | Designed to survive redeploy |
| Signed-in owner Investors | `server/production-api.js` | Supabase `cre_investors`, scoped to the authenticated owner | none | Designed to survive redeploy |
| Paid-resource usage | `server/durable-cost.js` | Supabase `cre_usage_daily` via validated server credential or registered token RPC | no authoritative local counter | Designed to survive redeploy and concurrent instances |
| 3D quota | `server/durable-cost.js` | Supabase quota RPC / `cre_quota_daily` | none; paid request fails closed when quota storage is unavailable | Designed to survive redeploy and concurrent instances |
| Legacy local account DB | `server/db.js` | not a production identity authority | `app.db` is legacy/local only | disposable in production |
| Socrata response cache | `server/adapters/socrata.js` | authoritative data remains NYC source response, not the cache itself | response cache | disposable by design |

## Fail-closed persistence rule

`server/authority-release.js` constructs the deployment-wide gate stores through `durableStore()` and wraps writes with `strictSave()`. In production, a result with `durable:false` is converted to HTTP 503 `durable_storage_required`; a failed durable write is not reported as successful and the production write path does not mutate ephemeral disk first.

The durable backend is selected from the running process, not inferred from an environment-variable name:

1. direct Postgres when a usable connection exists;
2. validated privileged PostgREST;
3. registered token-gated Supabase RPC;
4. disk only for local/development fallback.

A legacy anon JWT in `SUPABASE_SERVICE_ROLE_KEY` is not accepted as an admin credential. Modern `sb_secret_...` keys are API keys rather than JWT bearer tokens. `restAvailable()` proves privilege with the read-only `account_delete_schema_check()` RPC instead of treating an RLS-protected `SELECT ... -> 200 []` as proof of write capability.

## Verification status

- **P6.1 / P6.2 — PASS.** Runtime write surfaces have been instrumented and the production owners are identified above.
- **P6.3 — PASS.** Required user/deployment state is distinguished from disposable cache/local state.
- **P6.4 — PASS structurally.** Gate-only Pipeline and Investors are no longer accepted as disk-only production writes; signed-in state is in user-scoped Supabase tables.
- **P6.5 — PASS in code/contract tests.** Production saves fail closed when the selected durable backend cannot persist them.
- **P6.6 — PASS in engine-level redeploy simulation.** `tests/durable-store.test.mjs` writes JSONB to a real PGlite/Postgres engine, destroys `APP_DATA_DIR`, and proves the database row survives and round-trips unchanged.
- **P6.7 — EXTERNAL CONTROL-PLANE VERIFICATION REQUIRED FOR FINAL CERTIFICATION.** `tests/browser/production-verify.cjs` now supports a two-run marker proof across an independently changed Render instance and, in `P20_CERTIFY=1` mode, treats an unperformed restart/redeploy check as a release failure rather than PASS. A genuine Render restart/redeploy still requires the Render control plane; it cannot be manufactured by a repository or database test.

## Historical note

The 2026-08-13 runtime capture found writes to `server/data/investors-pool.json`, `server/data/kanban-pipeline.json`, SQLite WAL/SHM files, and the Socrata cache. That capture remains useful evidence of the defect that prompted this work, but it is **historical evidence, not the current production persistence architecture**. Future release decisions must use the current code, current runtime probes, and the Phase 20 deployed-service verifier rather than the superseded disk classification.
