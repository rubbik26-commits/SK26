# Lucia + buyerDB refresh cutover

## Decision

Lucia keeps one canonical buyer warehouse: the existing `sbi_*` tables in the
existing Supabase project. The static `NEW_YORK_CLOSED_ENRICHED_v8.csv` is an
audited baseline/import source, not a second production database. Lucia's
buyer-ranking and history APIs continue to read `api_buyers` and `api_entity`,
which preserve the buyer → deal → property-address chain.

The scheduled Render component is `type: cron`. It is not another Lucia web
service and it does not run SQL directly. It calls buyerDB's existing
`/api/scrapers/run` control plane, which creates auditable `sbi_source_runs`,
de-duplicates active work, and routes each source through its existing worker.

The Python files under `buyerDB/skyline/worker` are not copied into Lucia. The
current `run_requested.py` supports only a subset of the production jobs and
routes Traded through legacy unprefixed ledgers that are not present in the
canonical database. Copying it would create a second, internally inconsistent
write path. Lucia reuses the live TypeScript/Edge orchestration documented in
`buyerDB/architecture/SOP-daily-refresh.md` instead.

## What this release changes

- Adds one Render cron service named `lucia-buyerdb-refresh` alongside the one
  existing web service named `lucia`.
- Keeps the cron disabled with `BUYERDB_REFRESH_ENABLED=0` until cutover.
- Adds a service-role-only, read-only Supabase RPC that reports freshness for
  every production source and embeds the existing Manhattan buyer/address
  integrity certificate.
- Adds the owner-only `GET /api/buyer-intel/status` endpoint.
- Does not replace, delete, truncate, backfill, or seed any buyer data.

## Variables: exact meaning

### Render cron

| Variable | Required value | Purpose |
| --- | --- | --- |
| `BUYERDB_REFRESH_ENABLED` | `0` before cutover; `1` only after verification | Hard stop. When not exactly `1`, the process exits successfully without making a request. |
| `BUYERDB_CONTROL_PLANE_URL` | `https://buyerdb.netlify.app` | Existing buyerDB control plane. The dispatcher forces the path to `/api/scrapers/run` and requires HTTPS. |
| `BUYERDB_REFRESH_JOB` | `full_refresh` after all source credentials pass | Uses buyerDB's existing fan-out, which records a separate run for every source. For the first smoke test use `acris_refresh`. |
| `BUYERDB_SCRAPER_TRIGGER_SECRET` | Same value as Netlify `SCRAPER_TRIGGER_SECRET` | Shared request credential. This is the only new Render secret. It is not a Supabase key and must not be exposed to the browser. |

Do not copy `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, or a database URL
into the cron. buyerDB's control plane already owns the database connection.

### buyerDB Netlify prerequisites

The following are existing buyerDB runtime variables, not new Lucia web-service
variables:

| Variable | Needed for |
| --- | --- |
| `SCRAPER_TRIGGER_SECRET` | Authenticates `/api/scrapers/run`; must match the Render cron secret. |
| `SUPABASE_SERVER_KEY` (or the runtime's accepted server-key alias) | Creates and updates source runs and canonical records. |
| `SCRAPERAPI_KEY` | Traded source. |
| `APIFY_TOKEN` and `APIFY_CREXI_ACTOR` | Crexi source. |

As observed before this release, buyerDB's runtime-health response reported the
scheduler credential, server key, ScraperAPI, and Apify values as unavailable.
Do not enable `full_refresh` until the live runtime-health response confirms the
required values. Never invent a value or substitute an unrelated secret.

## Zero-duplication cutover

1. Keep `BUYERDB_REFRESH_ENABLED=0`.
2. Merge and deploy the code so the additive migration and status endpoint are
   present. Confirm the existing Lucia web service remains healthy.
3. In Render, update the Blueprint that manages the existing `lucia` service,
   or explicitly add that existing service. Do **not** select **Create all as
   new**. Render documents that a new Blueprint replication appends a suffix and
   provisions independent resources.
4. Set one random shared trigger secret in buyerDB Netlify and the
   `lucia-buyerdb-refresh` cron. Do not place it in GitHub.
5. Restore the required buyerDB Netlify server/source credentials and verify
   `/api/runtime-health` without exposing their values.
6. Temporarily set `BUYERDB_REFRESH_JOB=acris_refresh` and run the cron once.
   Require an accepted request, one new completed `acris_refresh` source run,
   and a successful `GET /api/buyer-intel/status` response.
7. Compare pre/post integrity. All of these must remain true:
   - `missingPropertyAddresses = 0`;
   - the buyer/deal/property and deal-party/entity orphan counts remain `0`;
   - duplicate deal groups remain `0`;
   - invalid ACRIS party rows remain `0`;
   - a known top buyer still returns every recorded transaction with its full
     property address and source URL.
8. Only after step 7, pause the old schedule for the same source. The current
   Supabase job `sbi-acris-refresh-daily` must not run alongside the Render ACRIS
   schedule. Preserve the job definition until the replacement has completed a
   full observation window; pause it rather than deleting it.
9. After ScraperAPI and Apify are verified, set the job back to `full_refresh`,
   perform one supervised run, and confirm every source has its own completed
   audit row.
10. Set `BUYERDB_REFRESH_ENABLED=1`. Keep the former Netlify scheduled triggers
    paused so there is exactly one scheduler and one canonical write path.

Rollback is immediate and data-safe: set `BUYERDB_REFRESH_ENABLED=0`. This
stops new dispatches without reverting migrations, deleting audit rows, or
touching buyer, deal, contact, or property records.

## Operational acceptance

`GET /api/buyer-intel/status` is healthy only when both dimensions pass:

1. Canonical integrity: Manhattan buyer/deal rows exist, repeat-buyer canonical
   identity is active, and no buyer transaction is missing its property address.
2. Refresh integrity: all seven source jobs have a recent completed run and no
   requested/running job has been stuck for more than two hours.

Freshness failure does not hide historical buyer data. It makes the stale state
explicit so an old warehouse cannot be mistaken for a current one.

