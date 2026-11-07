-- Token-gated account deletion.
--
-- WHY
-- /api/account-delete answered 501 unless SUPABASE_SERVICE_ROLE_KEY was
-- configured, and this deployment does not set one. Every other durable write
-- already travels the publishable-key-plus-registered-token path
-- (app_state, the usage meter, the 3D quota); this migration extends that
-- exact trust model to deletion. The server first verifies the caller's JWT
-- against auth (/auth/v1/user) and only then asks this function to remove the
-- verified user — the token proves the request comes from the deployment,
-- the JWT proved the account is the caller's own.
--
-- auth.users cascades to auth.identities / sessions / refresh tokens and to
-- every cre_* workspace row via their user_id/id foreign keys. Proven live on
-- 2026-08-17: the signed-in round-trip probe account was removed exactly this
-- way and every per-table count reached zero.
create or replace function public.cre_account_delete_tk(p_user_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_cnt integer;
begin
  if not public.app_state_token_ok(p_token) then
    raise exception 'account: token not registered' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'account: user id required' using errcode = '22023';
  end if;
  delete from auth.users where id = p_user_id;
  get diagnostics v_cnt = row_count;
  return jsonb_build_object('deleted', v_cnt > 0);
end;
$$;

-- Revoke from the roles that actually hold the default grant, by name — the
-- ALTER DEFAULT PRIVILEGES lesson recorded in 202608150006 — then grant the
-- token-gated surface deliberately. anon/authenticated may EXECUTE because the
-- function itself refuses without a registered token, exactly like
-- app_state_get/app_state_put and the cre_usage_*_tk family.
revoke all on function public.cre_account_delete_tk(uuid, text) from public, anon, authenticated;
grant execute on function public.cre_account_delete_tk(uuid, text) to anon, authenticated, service_role;
