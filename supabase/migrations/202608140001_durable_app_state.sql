-- Deployment-wide state that has to survive a redeploy.
--
-- Render's free plan has no persistent disk: server/data/ is part of the deploy
-- image and is recreated from git on every deploy, every restart and every cold
-- start after the service idles. The kanban board, the investor pool, the usage
-- meters and the 3D quota all lived there, which is why the site looked
-- identical after each deploy — the saved state was gone and the seeded
-- defaults were back.
--
-- Rows here are keyed by the document name the code used to write to disk, so
-- the mapping is one-to-one with the old files and a deployment can adopt what
-- it already had (server/durable-store.js copies the on-disk document in on
-- first read when the row is absent).
--
-- This is deliberately NOT per-user. Per-user state already has typed tables
-- (cre_pipeline, cre_watchlist, cre_investors, …) reached with the caller's own
-- bearer under RLS. This table is the tier below that: the shared board that
-- everyone entering through the password gate without an account sees. It is
-- written only by the server with the service role, never from the browser.
create table if not exists public.app_state (
  name       text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

-- No policy is granted to anon or authenticated on purpose. The service role
-- bypasses RLS, so the server can read and write; a browser holding a
-- publishable key cannot touch the shared board even if it learns the table
-- name. Adding a permissive policy here would hand every gate-tier visitor
-- write access to everyone else's kanban.

comment on table public.app_state is
  'Deployment-wide documents that must outlive the container: kanban-pipeline.json, investors-pool.json, usage-meters.json, 3d-sessions.json. Written by the server with the service role only.';
