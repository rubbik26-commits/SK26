-- Keep the existing NYC RE Market Intel authorization semantics while avoiding
-- per-row auth.uid()/owner-role re-evaluation in Supabase RLS. This migration
-- does not broaden access: every predicate is the same predicate already used
-- by 202608130001_exact_production_workspace.sql, wrapped in an initplan-friendly
-- scalar SELECT as recommended by the Supabase database linter.

-- cre_pipeline_history.user_id is a foreign key to auth.users and is also the
-- RLS selector. The original workspace migration indexed pipeline_id but not
-- user_id, leaving deletes/joins and the per-user history read path uncovered.
create index if not exists cre_pipeline_history_user_idx
  on public.cre_pipeline_history (user_id, changed_at desc);

-- Profiles: self row, plus owner/admin visibility. Normal users still cannot
-- insert an owner/admin profile or update the role column.
drop policy if exists cre_profiles_select on public.cre_profiles;
create policy cre_profiles_select on public.cre_profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or (select public.cre_is_owner())
  );

drop policy if exists cre_profiles_insert on public.cre_profiles;
create policy cre_profiles_insert on public.cre_profiles
  for insert to authenticated
  with check (
    id = (select auth.uid())
    and role = 'user'
  );

drop policy if exists cre_profiles_update on public.cre_profiles;
create policy cre_profiles_update on public.cre_profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Per-user workspace isolation. These remain ALL/SELECT policies with the same
-- role and same ownership checks as the initial production workspace migration.
drop policy if exists cre_watchlist_own on public.cre_watchlist;
create policy cre_watchlist_own on public.cre_watchlist
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists cre_pipeline_own on public.cre_pipeline;
create policy cre_pipeline_own on public.cre_pipeline
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists cre_pipeline_history_own on public.cre_pipeline_history;
create policy cre_pipeline_history_own on public.cre_pipeline_history
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists cre_canvass_own on public.cre_canvass;
create policy cre_canvass_own on public.cre_canvass
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists cre_investors_owner_own on public.cre_investors;
create policy cre_investors_owner_own on public.cre_investors
  for all to authenticated
  using (
    user_id = (select auth.uid())
    and (select public.cre_is_owner())
  )
  with check (
    user_id = (select auth.uid())
    and (select public.cre_is_owner())
  );

-- The migration runner creates public.schema_migrations before it applies the
-- files in this directory. It is deployment metadata, never an application
-- client table, so close the direct PostgREST surface without adding a policy.
-- The guarded block also keeps this file safe when applied by tooling that uses
-- Supabase's own migration ledger and therefore has not created this table.
do $$
begin
  if to_regclass('public.schema_migrations') is not null then
    execute 'alter table public.schema_migrations enable row level security';
    execute 'revoke all on table public.schema_migrations from anon, authenticated';
  end if;
end
$$;
