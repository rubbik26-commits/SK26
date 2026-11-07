# NYC RE Market Intel

Block-by-block multifamily & development intelligence for New York City — a
live "map room" covering Manhattan, Brooklyn, and LIC/Queens: opportunities, a
full tax-lot grid with zoning/air-rights/ownership lenses, parcel dossiers,
seller-propensity radar, underwriting, and branded printable reports.

**What is served:** the owner's original compiled production frontend, byte for
byte. The immutable Vite bundle (`index-BbnE3o5g.js` / `index-shmfCHKD.css`) is
checksum-pinned and reconstructed at build time from a chunk set committed in
this repository — no network fetch, no legacy origin, no substitute bytes.
Behind it, this repo's Express server answers that bundle's exact API contract
from live NYC public records and a PostgreSQL + PostGIS parcel store. Accounts
and private workspace data live in Supabase.

## Architecture

```
                 Render (web service, node)
  ┌──────────────────────────────────────────────────────┐
  │  site gate (SITE_PASSWORD)  →  everything but         │
  │                                /assets/* and /healthz │
  │                                                       │
  │  Express (server.js)                                  │
  │   ├── immutable frontend  public/assets/*  (SHA-256)  │
  │   ├── /js/supabase-env.js  → project config for the   │
  │   │     bundle's auth bridge                          │
  │   └── ~50 JSON endpoints matched to the bundle        │
  └───────┬───────────────────┬───────────────────┬───────┘
          │                   │                   │
   NYC Open Data        PostgreSQL+PostGIS      Supabase
   (Socrata, live)      parcels / acris_docs    auth, profiles,
   PLUTO · ACRIS ·      dob_filings · ntas      watchlist, pipeline,
   DOB · DOF · HPD      tax_bills               canvass, 3D quota
```

Three data planes, in priority order per endpoint:

1. **PostGIS parcel store** — real MapPLUTO lot polygons and the documents
   attached to them. Spatial questions are answered in SQL: `ST_Contains` for a
   map click, `ST_MakeEnvelope` for a viewport, `ST_Touches` for contiguous
   assemblage. Populated by the ingestion workers in `scripts/ingest/`.
2. **Live NYC Open Data** — Socrata queries at request time (PLUTO, ACRIS,
   DOB/DOB NOW, DOF rolling sales and valuation, HPD, ECB, 311, LL84). This is
   the fallback whenever the store is not configured, and remains the source
   for time-sensitive pulls.
3. **Curated universe** — the owner's authored parcel records, used only so the
   home strip cannot render empty on a cold deploy.

A failed authoritative pull is never replaced with invented facts:
`server/production-live-guard.js` turns an unavailable source into an explicit
`live_source_unavailable`, and unconfigured subsystems report
`configured: false` rather than fabricating a result.

## Quick start

```bash
npm install                          # postinstall vendors the exact frontend
node scripts/reconstruct-frontend.js # rebuild public/assets from committed chunks
npm start                            # http://localhost:5175
```

The server verifies both immutable assets against their pinned SHA-256 before
it listens, and exits if they cannot be produced from local bytes.

## Deployment (Render)

`render.yaml` is the version-controlled blueprint:

| Setting | Value |
| --- | --- |
| Build | `npm install && node scripts/reconstruct-frontend.js` |
| Start | `node server.js` |
| Health check | `/healthz` (ungated) |

Environment keys are declared in the blueprint with `sync: false` (set them in
the Render dashboard):

| Variable | Enables |
| --- | --- |
| `SITE_PASSWORD` | The global password gate (every route but `/assets/*` and `/healthz`) |
| `OWNER_PASSWORD` | Owner tier — Investors, Source Registry, CRM xref, similar-properties |
| `SUPABASE_URL` | **The** production Supabase project for the whole app — server *and* the immutable frontend. It is the sole database identity: there is no baked-in fallback, and a production boot without it refuses Supabase-backed features rather than reaching a legacy project |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key for that project (also served to the browser via `/js/supabase-env.js`) |
| `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Service credential for account deletion, durable 3D quota and PostGIS ingestion. The `sb_secret_…` secret key is preferred; a legacy `service_role` JWT also works. (An `anon`-role JWT here is a misconfiguration — it fails RLS-protected writes.) |
| `SUPABASE_DB_URL` | Direct Postgres connection string (Supabase pooler/session URI). When set, the build applies migrations from `supabase/migrations/` byte-exact and durable state uses this connection (`backend: "postgres"`, `survivesRedeploy: true`) instead of the token-RPC fallback |
| `APP_STATE_TOKEN` | Registered write token for the token-gated `app_state` RPCs — the publishable-key path for durable state when no direct DB/service credential is present. Its SHA-256 must be registered once in `app_state_auth` |
| `OWNER_EMAIL` | Comma-separated owner account allowlist |
| `GOOGLE_MAPS_API_KEY` | Street View / static map imagery |
| `GOOGLE_3D_KEY` | Photorealistic 3D tiles session endpoint (metered, fails closed) |
| `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID` | CRM cross-reference |
| `SERPER_API_KEY` | Live listing-check web search |
| `CENSUS_API_KEY` | ACS demographics |
| `PINECONE_API_KEY` / `PINECONE_INDEX_HOST` | Similar-property vector search |
| `POSTGIS_SUPABASE_URL` / `POSTGIS_SUPABASE_KEY` | Point the parcel store at a different project than auth (optional) |

### The immutable frontend

`server/data/production-frontend/` holds the complete brotli+base64 encoding of
the compiled bundle, split into `.part-NNN.b64` chunks with a `manifest.json`.
That chunk set is the canonical source:

- `npm run reconstruct` — decode → verify SHA-256 → write `public/assets/`
- `npm run chunks` — re-encode the chunk set from verified exact assets
- `/api/frontend-parity` — live report of served bytes vs pinned hashes

Nothing in the build or runtime path contacts the legacy origin. If a byte
cannot be reproduced locally, the build fails and the server refuses to start.

### Supabase decoupling

The compiled bundle has the original project's URL and publishable key baked
in. Rather than patch the pinned assets, the server serves
`/js/supabase-env.js` (from `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`) and
`public/js/production-auth-bridge.js` — loaded ahead of the bundle — rewrites
any request aimed at the baked-in project to the configured `SUPABASE_URL`
project and swaps the key in `apikey`/`authorization` headers. The bridge also
attaches the current Supabase access token to same-origin `/api/*` calls so
private endpoints can enforce the account boundary, selecting the session token
by its `iss` claim so a browser holding two projects' sessions sends the right
one. `SUPABASE_URL` is the only source of the project identity — the baked-in
legacy values exist solely so the bridge can *recognize* legacy-bound traffic in
order to rewrite it; they are never served as the deployment's own project.

## Database

Migrations live in `supabase/migrations/` and are applied in filename order.
When `SUPABASE_DB_URL` (a direct Postgres connection string) is set on the web
service, `scripts/apply-migrations.mjs` runs every migration at build time,
byte-for-byte from these files, and records each in `public.schema_migrations`;
`scripts/verify-production-schema.mjs` then fails the deploy unless the complete
schema, the anon-lockout grants, the self-delete revision and the reconciliation
lifecycle are all present. A migration added to the repo but not applied to the
target database fails the build rather than deploying a half-migrated schema.

| Migration | Contents |
| --- | --- |
| `202608130001_exact_production_workspace.sql` | Accounts workspace: `cre_profiles`, `cre_watchlist`, `cre_pipeline`, `cre_pipeline_history`, `cre_canvass`, `cre_investors`, per-user RLS, durable usage/quota tables and the `cre_reserve_3d_session` RPC |
| `202608130002_unify_pipeline_contracts.sql` | Unify the Kanban `oppId` stages with parcel pipeline rows in one `cre_pipeline` table |
| `202608130003_postgis_geospatial.sql` | PostGIS parcel architecture — `parcels`, `acris_docs`, `dob_filings`, `tax_bills`, `ntas`, spatial RPCs, ingest RPCs (below) |
| `202608140001_durable_app_state.sql` | `app_state` — deployment-wide state (kanban, investor pool, meters) that survives a redeploy; service-role write only |
| `202608150001_app_state_publishable_key_rpc.sql` | Token-gated `app_state_get/put/adopt/bootstrap` so durable state works with a publishable key plus a registered `APP_STATE_TOKEN`; hardened operator bootstrap window |
| `202608150002_acris_docs_multi_lot_key.sql` | Widen `acris_docs` primary key to `(document_id, bbl)` so multi-lot deeds keep every parcel link |
| `202608150003_finishline_authority_release.sql` | Recursive contiguous-owner `assemblage_at`; `release_schema_check` deploy probe; pipeline BBL grant |
| `202608150003_pipeline_bbl_update_grant.sql` | Allow `cre_pipeline.bbl` to be backfilled on UPDATE (feeds the maturity wall) |
| `202608150004_cre_revoke_anon_default_grants.sql` | Revoke the `anon` default grants Supabase attaches to the `cre_*` tables at creation |
| `202608150004_postgis_ingest_certificate.sql` | `cre_ingest_certificate` + `mark_full_ingest_complete` / `postgis_store_status` — a warehouse is trusted only after a certified full ingest |
| `202608150005_ingest_reconciliation.sql` | Atomic full-ingest lifecycle: singleton lease, `full_sync_id` tagging, reconcile-by-delete, `ingest_reconciliation_schema_check` |
| `202608150006_ingest_revoke_anon_default_grants.sql` | Lock every ingest/reconcile writer to `service_role`; `alter default privileges … revoke execute … from anon`; extend `release_schema_check` with grant assertions |
| `202608170001_usage_meter_token_rpc.sql` | Token-gated `cre_usage_bump_tk` / `cre_usage_read_tk` / `cre_reserve_3d_session_tk` so the spend panel works with the publishable key |
| `202608170002_account_delete_token_rpc.sql` | Token-gated `cre_account_delete_tk` (JWT verified by the server, token proves the deployment) |
| `202608170003_account_delete_self_only.sql` | Harden deletion: the database enforces `auth.uid()` self-only; anon execution revoked; `account_delete_schema_check` revision probe |

The geospatial migration enables PostGIS and creates:

- **`parcels`** — one row per BBL: borough/block/lot, address, owner, zoning,
  land use, FAR (built/resid/comm/facil), units, assessments, the full source
  record in `attrs`, and `geom geometry(MultiPolygon, 4326)` for the lot
  polygon, with a GiST index.
- **`acris_docs`** — recorded deeds and mortgages with flattened parties.
- **`dob_filings`** — DOB NOW job filings and DOB permit issuance.
- **`tax_bills`** — DOF valuation roll, one row per BBL × year.
- **`ntas`** — 2020 Neighborhood Tabulation Area polygons (GiST indexed).

Read functions (`lot_at`, `nta_polys`, `assemblage_at`,
`parcels_opportunities`, `tax_history_at`, `parcel_contacts`) are granted to
`anon`/`authenticated`; the `ingest_parcels` / `ingest_ntas` upsert functions
are `service_role` only. All five tables have RLS enabled — public NYC records
are world-readable, and writes happen only through the service role.

### Building the database

One command takes an empty database to a verified parcel store — schema, real
NYC records, and proof that the spatial functions answer correctly:

```bash
DATABASE_URL='postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres' \
  npm run db:setup -- --zips=10001,10011 --docs
```

It applies every migration in order (the workspace migrations are skipped
automatically when the target isn't a Supabase project with `auth.users`),
loads MapPLUTO lot polygons and NTA polygons, optionally pulls ACRIS/DOB/DOF
records for the largest parcels, then verifies `lot_at` (ST_Contains),
`nta_polys` (ST_MakeEnvelope), `assemblage_at` (ST_Touches) and
`parcels_opportunities` against the data it just loaded. Re-running upserts
rather than duplicating. Flags: `--limit`, `--docs-limit`, `--skip-ingest`.

Afterwards set `SUPABASE_URL` and a service/secret key on the web service so the
endpoints read the store; without them they keep answering from live NYC Open
Data.

On Render, the simplest path is to set `SUPABASE_DB_URL` to the project's direct
Postgres URI: the build then applies every migration in `supabase/migrations/`
byte-exact and verifies the schema before the service starts, so the database
stays in lockstep with the repo on every deploy without a separate `db:setup`
run. (The Render build network can reach the database directly; a sandboxed
environment restricted to HTTPS egress cannot, and must apply schema through the
Supabase API instead.)

### Incremental ingestion

```bash
export SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…
npm run ingest -- --zips=10001,10011 --limit=400     # everything, bounded
npm run ingest:mappluto -- --borough=MN --limit=20000 # lot polygons only
npm run ingest:nta                                    # NTA polygons
npm run ingest:acris -- --bbls=1008350041             # per-parcel documents
```

`scripts/ingest/mappluto.js` reads lot geometry from the Department of City
Planning MapPLUTO FeatureServer; `nta.js`, `acris.js`, `dob.js` and `tax.js`
read Socrata through the same adapters the live API uses. Geometry is
normalized in SQL (`ST_GeomFromGeoJSON` → `ST_MakeValid` → `ST_Multi`), and
`lat`/`lng` default to `ST_PointOnSurface` so every lot has a usable centroid.

## Security

`server/gate.js` reproduces the legacy password wall. With `SITE_PASSWORD` set,
every route is protected except `/assets/*` and `/healthz`. Three credentials
are accepted: the `ndi_gate` cookie from `POST /__gate`, the legacy
`site_access` cookie (both set by the same form), or HTTP Basic auth for
curl/CI. Unauthenticated `/api/*` requests get a `401` JSON envelope; page
requests get the password form. `OWNER_PASSWORD` admits the owner tier, which
is what flips app-wide owner mode.

## Pages

| Route | What it is |
| --- | --- |
| `/` | **Market Intel** — markers, NTA overlay, tax-lot grid with land-use / air-rights / ownership lenses, buildings mode, 3D city |
| `/dossier` | Parcel dossier: propensity, distress, debt maturity, LL97/J-51 cliffs, tax history, assemblage, contacts |
| `/pipeline` | Pipeline / CRM |
| `/live` | Live details — geolocated lock-on + pick-on-map nearby intel |
| `/territory` | Territory mastery — census, deep-dive, cold-call hooks |
| `/radar` | Deal Radar — seller-propensity scan with model-validation backtest |
| `/calculator` | Underwriting — NOI → cap/DSCR/IRR/waterfall, BOV / OM / Deck documents |
| `/comps` | Comps / land index |
| `/present` | Presentation mode |
| `/investors` | Investor buy-box pool (owner tier) |
| `/desk` | My Desk — watchlist, pipeline, canvass log, debt maturity wall |
| `/sources` | Source registry + integration status |

## Layout

```
server.js                      Express bootstrap; verifies exact assets, then listens
server/
  gate.js                      Global site gate (cookie + Basic auth tiers)
  supabase-env.js              /js/supabase-env.js — project config for the bundle
  production-frontend.js       Immutable asset router (local sources only)
  routes-bundle.js             The bundle's API contract, endpoint by endpoint
  parity-routes.js             Public-record parity routes
  live.js / opps-live.js       Live NYC pulls and the opportunity universe
  production-*.js              Regulatory, analytics, dossier, imagery, private APIs
  adapters/
    postgis.js                 PostGIS store over PostgREST RPC
    nyc.js / socrata.js        NYC Open Data
    ll84-current.js, dof-benefits.js, dob-sustainability.js, …
  data/production-frontend/    Committed chunk set for the immutable bundle
public/
  index.html                   Shell: supabase-env → auth bridge → compiled bundle
  assets/                      The exact production bundle (checksum pinned)
  js/production-auth-bridge.js Supabase retarget + bearer propagation
scripts/
  reconstruct-frontend.js      Chunks → verified public/assets (build step)
  make-frontend-chunks.js      Exact assets → chunk set
  ingest/                      NYC Open Data → PostGIS workers
supabase/migrations/           Workspace + PostGIS schema
tests/                         Golden units, API parity, hardening, migration gate
```

## Tests

```bash
npm test
```

- `golden-units` — scoring and underwriting math pinned to known-good numbers.
- `api-parity` — spawns the real server, exercises the gate matrix (Basic auth,
  `site_access` cookie, `/healthz` and `/assets/*` bypass), the API contracts,
  owner tiers, row-level isolation and the fail-closed 3D quota.
- `production-hardening` — module validity, checksum pinning, live-source
  guards, Supabase RLS/quota SQL.
- `render-migration` — chunk reconstruction against the pinned hashes, the
  no-network asset pipeline, `render.yaml`'s build/start/health/env contract,
  script order in `index.html`, the `/api/cliffs` safe-number normalizers, and
  the PostGIS layer (`ST_Contains` / `ST_MakeEnvelope` / `ST_Touches`, RLS,
  service-role-only ingestion).
