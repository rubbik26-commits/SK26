# Deployment configuration

What to set in Render, why each thing matters, and how to check it worked.

Everything here is verifiable from the running service: `/api/status` reports
what the process actually resolved, not what was configured. Where this document
says "confirm X", there is a request you can make that answers it.

---

## 1. The one that decides whether anything saves

Render's free plan has **no persistent disk**. The container's filesystem is
rebuilt from the deploy image on every deploy, restart and cold start. So the
kanban board and the investor pool cannot live on disk — they live in Postgres.

Set **one** of these two paths.

### Path A — direct Postgres (simplest to verify)

| Variable | Value |
| --- | --- |
| `SUPABASE_DB_URL` | The project's privileged Postgres connection URI |

### Path B — publishable key + write token (no service-role key on the web host)

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | The project's publishable key |
| `APP_STATE_TOKEN` | The write token registered in `app_state_auth` |

`SUPABASE_PUBLISHABLE_KEY` is public by design — it is already inside the
compiled frontend bundle. It cannot write on its own: `app_state` is behind RLS
with no anonymous policy, and every write goes through a SECURITY DEFINER
function that requires the token.

### Confirming it

```
GET /api/status  ->  { "persistence": { "backend": "...", "survivesRedeploy": true } }
```

`backend` must be `postgres`, `supabase-rest` or `supabase-rpc`. If it is
`disk`, **nothing you save will survive the next deploy**, and the service will
say so in that same block rather than letting you find out later.

Under `NODE_ENV=production` a save that cannot be made durable is **refused**
with `503 durable_storage_required` rather than reported as successful. An
ephemeral save that looks like it worked is worse than a visible failure.

---

## 2. Which Supabase project

**`SUPABASE_URL` is effectively required.** If it is unset, the application
falls back to the project compiled into the original frontend bundle. That
project belongs to the original site, not to this deployment — you cannot apply
migrations to it, so the build gate can never be satisfied while it is the
target. Both build steps now say so by name before they fail:

```
[migrate] WARNING: SUPABASE_URL is not set, so the runtime target is the
          project baked into the compiled frontend: https://qrc….supabase.co
```

If you see that line in a Render build log, the fix is to set `SUPABASE_URL`
(and a matching key), not to hunt for a missing migration.

The build refuses to deploy against a project whose schema is incomplete. It
probes both `app_state` RPCs and all six `cre_*` workspace tables and names any
that are missing, because a project with the durable-state migration applied and
the workspace migration missing looks healthy — the kanban writes to `app_state`
successfully — while `/api/pipeline`, `/api/maturity-wall` and the owner spend
panel all point at tables that do not exist.

Apply every file in `supabase/migrations/` to the project `SUPABASE_URL` names.
`release_schema_check()` — created by
`202608150003_finishline_authority_release.sql` — is what the second gate calls,
and it is only present once the PostGIS warehouse tables exist. A project
missing them fails with `PGRST202`, which reads like a broken verifier and is
in fact an unapplied migration.

### Grants are verified, not assumed

A Supabase project ships `ALTER DEFAULT PRIVILEGES` that grant `EXECUTE` on
every new function in `public` to `anon` and `authenticated`. `REVOKE … FROM
PUBLIC` does not remove those — PUBLIC and `anon` are different grantees — so a
migration can revoke from public, grant to `service_role`, read as
service-role-only, and still be callable with the publishable key.

That is not theoretical: measured against the live project, the ten
SECURITY DEFINER ingest writers (`ingest_parcels`, `begin_full_ingest`,
`reconcile_full_public_record_store` and the rest) all answered TRUE to
`has_function_privilege('anon', …, 'execute')`. SECURITY DEFINER functions
bypass RLS by design, so there was no second line of defence behind them.

`202608150006_ingest_revoke_anon_default_grants.sql` revokes them by role name
and folds the resulting privilege matrix into `release_schema_check()`, so the
deploy fails closed if the grants ever regress. It asserts the public read
surface stays reachable too — an over-broad revoke would blank the map and the
dossier rather than failing loudly.

---

## 3. Access

| Variable | Effect |
| --- | --- |
| `SITE_PASSWORD` | Admits a member through the site gate |
| `OWNER_PASSWORD` | Admits the owner; unlocks Investors and the Source Registry |
| `OWNER_EMAIL` | The **only** production path to an owner role by account |

Local SQLite accounts are disabled under `NODE_ENV=production`: `/api/auth/*`
answers `410 Gone` and the routes are not mounted. The SQLite file lives in the
deploy image and is recreated empty on every cold start, so "first user becomes
owner" would hand ownership to whoever signed up after each restart. The
compiled frontend never requests those paths — it authenticates through
Supabase — so nothing user-facing depends on them.

---

## 4. Data sources

| Variable | Effect if unset |
| --- | --- |
| `NYC_OPEN_DATA_APP_TOKEN` *(alias `SOCRATA_APP_TOKEN`)* | Requests are unauthenticated and **rate-limited by IP** |
| `CENSUS_API_KEY` | Demographics report themselves unconfigured |
| `FRED_API_KEY` | The rate-context paragraph is omitted |

The Socrata token matters more than it looks. Unauthenticated rate limiting
appears as intermittent `HTTP 503`s, empty lot grids and "PLUTO ground truth
unavailable" — symptoms that read like product defects. NYC Open Data also has
genuine outages; during one, every live-data surface refuses and says so rather
than substituting a plausible figure.

---

## 5. Paid resources

| Variable | Effect |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` *(alias `GOOGLE_MAPS_KEY`)* | Street View and static map imagery |
| `GOOGLE_3D_KEY` | Photorealistic 3D |
| `GOOGLE_3D_DAILY_CAP` | Hard daily cap on 3D sessions (default 25) |

**Either spelling of the Maps key works.** They used to disagree: the blueprint
declared one name and the imagery modules read the other, so setting the
documented key produced a service that reported maps as configured while Street
View silently fetched nothing.

3D sessions are metered by an atomic Postgres reservation, not a counter in
memory, so the cap holds across restarts and concurrent requests. With the
durable store unreachable, 3D **fails closed** — an unmetered paid request is
worse than a missing feature.

---

## 6. Optional integrations

`SERPER_API_KEY`, `PINECONE_API_KEY` + `PINECONE_INDEX_HOST`,
`AIRTABLE_API_KEY` + `AIRTABLE_BASE_ID` (with optional
`AIRTABLE_SELLERS_TABLE`, `AIRTABLE_BUYERS_TABLE`, `AIRTABLE_MATCH_FIELDS`).

Each reports `configured: false` when unset and never fabricates a result.
Similar Properties still works without Pinecone — it falls back to the
public-record similarity engine and labels which engine answered.

---

## 7. PostGIS warehouse — off by default, deliberately

`POSTGIS_TRUSTED`, `POSTGIS_ENABLED`, `POSTGIS_SUPABASE_URL`,
`POSTGIS_SUPABASE_KEY`.

Leave `POSTGIS_TRUSTED` unset until a **complete** citywide ingest has run and
been certified against that project. The warehouse is an acceleration layer, not
permission to outrank fresh public records: reads require operator trust **and**
an unexpired full-ingest certificate that names a reconciled snapshot. The
certificate expires after 36 hours, so without a recurring ingest the store goes
stale and the application correctly falls back to live NYC sources.

---

## Verifying a deploy

```
GET /healthz                  200, ungated
GET /api/status               persistence.survivesRedeploy, dataMode, subsystems
```

`dataMode` is `live` when PLUTO and ACRIS both answer, `degraded` when one does,
`unavailable` when neither does. It is never `demo` on a production build —
that value would mean seeded figures were being served.

To prove persistence rather than trust it: save a kanban card, redeploy, and
load the board again. The card is in the database, not in the container.
