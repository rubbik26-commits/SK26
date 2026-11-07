-- Restore the authenticated execution boundary required by every owner-only RLS policy.
--
-- cre_investors, cre_usage_daily, cre_quota_daily and owner-wide profile reads
-- call public.cre_is_owner() from policies scoped TO authenticated. The live
-- project was found with an ACL containing only postgres + service_role, which
-- means an authenticated owner receives `permission denied for function
-- cre_is_owner` before the policy can decide whether the row is visible.
--
-- Keep the predicate off the anonymous RPC surface, restore it only for the
-- roles that need to evaluate the policies, and add a privileged schema probe
-- so this cannot silently regress again.

revoke all on function public.cre_is_owner()
  from public, anon, authenticated, service_role;
grant execute on function public.cre_is_owner()
  to authenticated, service_role;

create or replace function public.owner_workspace_schema_check()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select jsonb_build_object(
    'ok',
      has_function_privilege('authenticated', 'public.cre_is_owner()', 'EXECUTE')
      and not has_function_privilege('anon', 'public.cre_is_owner()', 'EXECUTE')
      and not has_column_privilege('authenticated', 'public.cre_profiles', 'role', 'UPDATE')
      and has_table_privilege('authenticated', 'public.cre_investors', 'SELECT')
      and has_table_privilege('authenticated', 'public.cre_watchlist', 'SELECT')
      and has_table_privilege('authenticated', 'public.cre_pipeline', 'SELECT')
      and has_table_privilege('authenticated', 'public.cre_canvass', 'SELECT'),
    'revision', '202608180004_owner_acl',
    'ownerPredicate', jsonb_build_object(
      'authenticatedExecute', has_function_privilege('authenticated', 'public.cre_is_owner()', 'EXECUTE'),
      'anonExecute', has_function_privilege('anon', 'public.cre_is_owner()', 'EXECUTE')
    ),
    'profileRole', jsonb_build_object(
      'authenticatedUpdate', has_column_privilege('authenticated', 'public.cre_profiles', 'role', 'UPDATE')
    ),
    'workspace', jsonb_build_object(
      'investorsSelect', has_table_privilege('authenticated', 'public.cre_investors', 'SELECT'),
      'watchlistSelect', has_table_privilege('authenticated', 'public.cre_watchlist', 'SELECT'),
      'pipelineSelect', has_table_privilege('authenticated', 'public.cre_pipeline', 'SELECT'),
      'canvassSelect', has_table_privilege('authenticated', 'public.cre_canvass', 'SELECT')
    )
  );
$$;

revoke all on function public.owner_workspace_schema_check()
  from public, anon, authenticated, service_role;
grant execute on function public.owner_workspace_schema_check()
  to service_role;
