-- Harden token-gated account deletion so the database itself enforces SELF.
--
-- The prior function trusted the web server to verify the caller's JWT, then
-- accepted any p_user_id as long as the deployment's shared app-state token was
-- valid. Because the RPC is exposed through PostgREST, a direct caller could
-- bypass the web server and submit another user's UUID. The deployment token is
-- therefore only a second factor; auth.uid() is the account authority.
create or replace function public.cre_account_delete_tk(p_user_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid;
  v_cnt integer;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'account: authenticated user required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id <> v_uid then
    raise exception 'account: self deletion only' using errcode = '42501';
  end if;
  if not public.app_state_token_ok(p_token) then
    raise exception 'account: deployment token not registered' using errcode = '42501';
  end if;

  delete from auth.users where id = v_uid;
  get diagnostics v_cnt = row_count;
  return jsonb_build_object('deleted', v_cnt > 0);
end;
$$;

-- Only a signed-in user can invoke the self-delete RPC. The service-role path
-- deletes through the Auth Admin endpoint and does not need this function.
revoke all on function public.cre_account_delete_tk(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.cre_account_delete_tk(uuid, text) to authenticated;

-- Non-secret release probe. release_schema_check predates this migration, so a
-- deployment using only PostgREST verification needs an object that can prove
-- this exact hardening revision was applied rather than merely proving that the
-- older, unsafe cre_account_delete_tk function exists.
create or replace function public.account_delete_schema_check()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'ok', to_regprocedure('public.cre_account_delete_tk(uuid,text)') is not null,
    'revision', '202608170003_self_only',
    'anonExecute', has_function_privilege('anon', 'public.cre_account_delete_tk(uuid,text)', 'EXECUTE'),
    'authenticatedExecute', has_function_privilege('authenticated', 'public.cre_account_delete_tk(uuid,text)', 'EXECUTE')
  );
$$;
revoke all on function public.account_delete_schema_check() from public, anon, authenticated, service_role;
grant execute on function public.account_delete_schema_check() to anon, authenticated, service_role;
