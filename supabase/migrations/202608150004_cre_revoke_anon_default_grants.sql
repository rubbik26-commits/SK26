-- Close the `anon` grants Supabase attached to the cre_* workspace at creation.
--
-- WHAT WAS WRONG
-- 202608130001 grants each workspace table to `authenticated` and says in its
-- own comment that the cost tables are "not directly writable by browser
-- users". Verified against the live project after applying it, every one of the
-- eight cre_* tables answered TRUE to has_table_privilege('anon', …, 'select'),
-- 'insert' AND 'update' — including cre_usage_daily and cre_quota_daily, the
-- paid-resource meters.
--
-- The cause is the same shape as the app_state_open_bootstrap defect: a Supabase
-- project ships ALTER DEFAULT PRIVILEGES that grant anon/authenticated at CREATE
-- time, so adding a grant for `authenticated` never removed anything, and
-- `revoke … from public` (which 202608130001 uses on its functions) does not
-- touch an explicit grant held by `anon`. A privilege has to be revoked from the
-- role that actually holds it.
--
-- IMPACT
-- Row-level security is enabled on all eight tables and every policy is scoped
-- `to authenticated`, so an anonymous request returns zero rows and an anonymous
-- write is refused by the policy. This is therefore hardening, not an open door
-- — but the table grant is the last line before RLS, the migration never meant
-- to extend it to anon, and one mis-scoped policy would turn it into a leak.
--
-- The `authenticated` grants are deliberately left exactly as they are; this
-- file only removes access the schema never intended to hand out.
revoke all on public.cre_profiles         from anon;
revoke all on public.cre_watchlist        from anon;
revoke all on public.cre_pipeline         from anon;
revoke all on public.cre_pipeline_history from anon;
revoke all on public.cre_canvass          from anon;
revoke all on public.cre_investors        from anon;
revoke all on public.cre_usage_daily      from anon;
revoke all on public.cre_quota_daily      from anon;

-- cre_is_owner() decides owner-only RLS. It is evaluated inside policies that
-- are themselves scoped `to authenticated`, so anon never needs to call it, and
-- it must not be reachable as /rest/v1/rpc/cre_is_owner.
revoke all on function public.cre_is_owner() from anon;

-- Trigger functions are not an API. PostgreSQL checks EXECUTE on a trigger
-- function when the trigger is CREATED, not when it fires, so removing these
-- grants leaves the cre_*_touch and stage-history triggers working while taking
-- both functions off the PostgREST RPC surface.
--
-- PUBLIC has to be named. Unlike cre_is_owner(), which 202608130001 already
-- revoked from public, these two were created with the default EXECUTE grant to
-- PUBLIC still in place. anon and authenticated inherit it, so revoking from
-- those two roles alone changed nothing — verified: both still answered TRUE to
-- has_function_privilege after an anon/authenticated-only revoke. Revoking from
-- PUBLIC is what actually removes it.
revoke all on function public.cre_touch_updated_at()       from public, anon, authenticated;
revoke all on function public.cre_pipeline_stage_history() from public, anon, authenticated;

-- Pin the one function that was left with a mutable search_path. It is
-- SECURITY INVOKER and only assigns now(), so the exposure is small, but a
-- resolvable search_path is free and the database linter flags it.
alter function public.cre_touch_updated_at() set search_path = public;
