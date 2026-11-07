# Final remediation state — 2026-08-18

This is the current release ledger for `final-release-remediation-2026-08-18`, synchronized with current ACRIS. It is intentionally strict: historical evidence is not relabeled as a current PASS, an Actions runner that never starts is not called a test failure, and an unrecovered original-server rule is not replaced with a plausible guess.

## Baseline

- Exact compiled frontend JS/CSS remains checksum-pinned and was not rebuilt or redesigned in this remediation.
- The production blueprint is the full **Owner** variant (`APP_VARIANT=owner`). Tests that specifically exercise the reduced member/owner split explicitly set `APP_VARIANT=user` so the two product contracts are not conflated.
- All remediation work was kept on `final-release-remediation-2026-08-18`; when concurrent work merged that branch into ACRIS, the same branch name was fast-forwarded/recreated from the new ACRIS head rather than starting a second work branch.

## Completed in code and live infrastructure

### Supabase credential authority

- One shared credential classifier distinguishes legacy `service_role` JWTs, modern `sb_secret_…` backend keys, and low-privilege anon/publishable credentials.
- A stale anon JWT in `SUPABASE_SERVICE_ROLE_KEY` cannot outrank a valid server secret.
- Modern secret keys are transported as Supabase API keys rather than fabricated JWT Bearer tokens.
- The same credential logic is used by runtime API code, account deletion, durable state, usage metering, migration/schema scripts, PostGIS reads and PostGIS ingestion workers.
- Regression coverage includes the exact stale-anon + valid-secret configuration that existed on the deployment.

### Durable state truthfulness

- `durable-store` no longer treats `GET app_state -> 200` as proof of privileged REST access. RLS can return 200 with zero visible rows to an anon client.
- The privileged REST path is proven by the read-only, service-only `account_delete_schema_check()` RPC before the service may report `supabase-rest` durability.
- Token-RPC durability remains available through the registered app-state token when privileged REST is unavailable.
- Production mutations still fail closed rather than report an ephemeral Render filesystem write as durable.

### PostGIS credential, URL and public-read ACL contracts

- `POSTGIS_SUPABASE_URL` is validated as an HTTP(S) Supabase API base; a PostgreSQL pooler/direct URI is rejected without logging the credential-bearing value and the adapter falls back to `SUPABASE_URL`.
- Runtime and ingestion workers use the same validated server/public credential transport.
- The runtime adapter has seven public-record read RPCs. Earlier security hardening preserved anon EXECUTE for only four and caused live `nta_polys` calls to return 401.
- Migration `202608180005_postgis_public_read_acl.sql` now grants the intended publishable-key read contract to all seven: `lot_at`, `nta_polys`, `assemblage_at`, `parcels_opportunities`, `tax_history_at`, `parcel_contacts`, and `postgis_store_status`.
- `postgis_public_read_schema_check()` is service-only and release verification requires revision `202608180005_postgis_public_read_acl` with every one of those seven anon grants true.
- The migration was applied directly to production Supabase and the schema check returned `ok:true` with all seven grants true.
- Current deployed Node build traffic calls `postgis_public_read_schema_check` successfully with HTTP 200 before continuing to ingest reconciliation and store-status verification.

### Render build reproducibility

- Render uses `npm ci --include=dev`; the checked-in lockfile controls dependency versions just as it does in release CI.

### Password/session bridge

- Legacy compiled-frontend Supabase URLs are retargeted to the active project.
- Recovery requests receive an explicit `redirect_to` equal to the live browser origin instead of inheriting a stale localhost URL.
- A legacy-project user JWT is never forwarded to the active project: it is replaced by an active-project session when one exists and stripped when one does not.
- Regression coverage includes both stale-token cases as well as same-origin owner bearer propagation and publishable-key swapping.
- Supabase's Auth redirect allow-list is a dashboard/control-plane setting not exposed by the connected Supabase tool, so that allow-list is not claimed as verified here.

### Owner usage meter

- Gate-password owner reads are committed by `server/authority-release.js`.
- Signed-in Supabase owner reads deliberately yield through compatibility routers and are committed by `server/production-api.js`.
- Both paths use the same durable `cre_usage_daily` source and the measured contract: 5,000 Street View loads and 10,000 Static Map loads.
- The signed-in route returns an honest 503 when the durable usage store is unavailable.
- A real-stack regression boots `server.js`, resolves a fake Supabase owner, passes the actual gate, reads the token-protected usage RPC, and asserts that `server/production-api.js` is the responding module.
- The reduced member/owner regression is pinned to `APP_VARIANT=user`; the production blueprint remains the full Owner build.

### Airtable truthfulness

- Airtable configuration is validated as a direct Airtable API contract rather than treated as configured merely because two environment variables are non-empty.
- The adapter accepts a PAT only in the correct token shape and a base only in the correct base-ID shape, and returns an explicit unconfigured/error state instead of allowing malformed credentials to masquerade as a healthy CRM integration.

### Market Report development / land stock

- The previously unresolved Development/Land stock denominator is now recovered from the original's published Territory development lens and confirmed against live PLUTO.
- The exact predicate is `lotarea > 1500 and builtfar < 1.5 and (residfar >= 3 or commfar >= 4)`.
- It reproduces all three original Market Report stock controls exactly: `11216=363`, `10002=132`, `10451=438`.
- Development stock, turnover and implied hold period are therefore no longer an open parity gap. Only classes for which production itself publishes no whole-building denominator remain contract nulls.

### Transit A/B disposition

- Transit was directly A/B measured against the original on the fixed dossier control; the earlier ledger statement that it had never been measured was incorrect.
- On BBL `1008350041`, the original returned `nearest:null` and zero stations while the rebuild resolved the recorded MTA station `34 St-Herald Sq` at 747 ft.
- That difference was explicitly classified and retained as a **truthful public-record enhancement**, not an unresolved unknown: removing a real MTA result merely to reproduce the original's empty response would reduce factual accuracy.
- Separate direct A/B work also recovered the original's well-formed unknown/retired-BBL response shape, so transit no longer incorrectly returns a parcel-not-found 404 for those cases.

### Phase 14 gate

- `tests/browser/phase14-matrix.cjs` is part of the blocking browser runner.
- The historical Dossier drawer FAIL was a harness false measurement; current source selects an actual interactive result, handles same-hash/full-URL Dossier navigation correctly and restores the route after the check.
- The old generated report remains historical until a browser runner actually executes the current matrix.

### Phase 17 Deck disposition

- Static call-site tracing of the byte-identical bundle shows only BOV and OM document-generation call sites. `Deck` is an unreachable fallback title, not a production UI control.
- Deck generation is therefore N/A for reachable original-production parity. Inventing a new Deck workflow would diverge from the authoritative frontend.

### Phase 20 certification path

- `.github/workflows/production-certification.yml` provides a manual fail-closed deployed-service verifier.
- Production credentials are referenced only as GitHub Actions secrets; no credential value is stored in repository files.
- It supports the required pre-redeploy marker run followed by a real restart/redeploy and a post-redeploy certification run. In certification mode, BLOCKED is fatal just like FAIL.

## Live Supabase verification completed in this pass

Production project: `pdvyuepsdnpxctmagdcq`.

Current schema contracts verified directly:

- `release_schema_check().ok = true`
- `account_delete_schema_check().ok = true`, revision `202608170003_self_only`, anon execute false, authenticated execute true
- `owner_workspace_schema_check().ok = true`, revision `202608180004_owner_acl`, authenticated users cannot update the profile role column
- `postgis_public_read_schema_check().ok = true`, revision `202608180005_postgis_public_read_acl`, all seven intended publishable read grants true
- `ingest_reconciliation_schema_check().ok = true`

Newest observed deployed Node build traffic returns HTTP 200 for the full fail-closed chain:

1. `release_schema_check`
2. `account_delete_schema_check`
3. `owner_workspace_schema_check`
4. `postgis_public_read_schema_check`
5. `ingest_reconciliation_schema_check`
6. `postgis_store_status`

Durable `app_state` rows, including the shared kanban/investor state, remain present across subsequent deployments, and one app-state write token remains registered.

## Supabase Security Advisor disposition

Current warnings are now limited to:

- INFO deny-by-default tables with RLS enabled and no direct policies;
- intentional SECURITY DEFINER RPCs that expose bounded public NYC record reads through the publishable key;
- authenticated self-service/owner helpers (`cre_account_delete_tk`, `cre_is_owner`);
- Supabase Auth leaked-password protection disabled.

The public-record RPCs have fixed search paths and explicit, tested ACLs. Revoking them solely to make the advisor empty would break the intended public-record data plane. Leaked-password protection is an Auth dashboard setting; the connected tool does not expose that switch.

## Still open because exact evidence/control-plane access is missing

### 1. Complete citywide PostGIS snapshot

Current live status remains:

- `fresh = false`
- `reason = no_complete_ingest_certificate`
- `fullDocuments = false`
- schema version `202608150005`
- warehouse source tables do not yet contain a completed citywide snapshot.

The application correctly leaves live NYC adapters authoritative until an actual unbounded source crawl succeeds and receives a reconciled UUID-tagged certificate. No certificate or warehouse rows are fabricated.

### 2. GitHub Actions execution infrastructure

Multiple current release-parity runs, including run `32190707191`, terminate with both jobs marked failed before step 1:

- `steps = null`
- no checkout
- no install
- no unit/browser process
- no logs
- no artifacts.

This is runner/account infrastructure, not a failing code assertion. The complete repository suite cannot honestly be called green until a runner actually starts.

### 3. Real Render restart/redeploy Phase 20 proof

No connected Render control-plane tool is available. The workflow is ready, but the required external restart/redeploy plus second marker verification cannot be performed from this environment. Do not call the candidate Phase 20 certified until it happens.

### 4. Photorealistic 3D cap

The supplied deployment configuration does not include the required Google 3D credential. The historical 3D quota boundary therefore remains unverified; no substitute provider is used.

### 5. `/api/nearby` exact original selector

Measured parity remains 8/10 control points byte-identical. The two outliers cannot be reproduced by the tested box/radius/nearest-N/row-cap/PLUTO-attribute rules without breaking controls that already match. No arbitrary selector is added.

### 6. `/api/footprints` exact original selector

The remaining point-footprint response is a measured safe superset and omits none of the original control footprints. The exact original coordinate-sensitive selector has not been recovered despite box/circle/tile/join/attribute testing. No guessed selector is added.

## Release decision

The fixable code/database defects found in this remediation are implemented and the live Supabase deployment gate is healthy. The system is **not yet entitled to a literal 100% / authority-release certification** because the full repository runner has not actually executed, the real Render restart proof has not occurred, the complete PostGIS snapshot is absent, the 3D credential is absent, and two original-server selection rules (`nearby` and point `footprints`) remain unrecovered.

Those items stay explicit by design. Converting any of them to guessed code or a fake PASS would violate the release standard this repository now enforces.
