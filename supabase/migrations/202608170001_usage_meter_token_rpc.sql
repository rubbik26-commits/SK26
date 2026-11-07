-- Token-gated paid-usage metering.
--
-- WHY
-- Every durable-meter path (cre_increment_usage, cre_reserve_3d_session, the
-- cre_usage_daily read) requires the service-role key, which this deployment
-- does not set. The spend panel therefore answered 503 usage_store_unavailable
-- with "supabase_service_key_missing" while the kanban saved durably right next
-- to it — because app_state writes go through SECURITY DEFINER RPCs that are
-- callable with the publishable key and validate a registered write token
-- (app_state_auth.token_sha) instead of demanding the service key. This
-- migration gives the usage meter that exact same trust pattern.
--
-- The service-role functions are left untouched; deployments that do configure
-- a service key keep using them. These *_tk wrappers are the
-- publishable-key-plus-token path, and every one refuses without a registered
-- token, so the publishable key alone still grants nothing.

create or replace function public.cre_usage_bump_tk(p_category text, p_amount bigint, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count bigint;
begin
  if not public.app_state_token_ok(p_token) then
    raise exception 'usage: token not registered' using errcode = '42501';
  end if;
  if coalesce(p_category, '') = '' then
    raise exception 'usage: category required' using errcode = '22023';
  end if;
  -- The table's own check constraint restricts category to the three paid
  -- meters; an unknown category raises rather than silently creating a row.
  insert into public.cre_usage_daily (usage_date, category, count)
  values (current_date, p_category, greatest(0, coalesce(p_amount, 0)))
  on conflict (usage_date, category)
    do update set count = public.cre_usage_daily.count + excluded.count,
                  updated_at = now()
  returning count into v_count;
  return jsonb_build_object('ok', true, 'usageDate', current_date, 'category', p_category, 'count', v_count);
end;
$$;

create or replace function public.cre_usage_read_tk(p_month text, p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_start date;
  v_rows jsonb;
begin
  if not public.app_state_token_ok(p_token) then
    raise exception 'usage: token not registered' using errcode = '42501';
  end if;
  if p_month !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'usage: p_month must be YYYY-MM' using errcode = '22023';
  end if;
  v_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  select coalesce(jsonb_agg(jsonb_build_object(
           'category', u.category,
           'count', u.count,
           'usageDate', u.usage_date
         ) order by u.usage_date, u.category), '[]'::jsonb)
    into v_rows
    from public.cre_usage_daily u
   where u.usage_date >= v_start
     and u.usage_date < (v_start + interval '1 month');
  return jsonb_build_object('month', p_month, 'rows', v_rows);
end;
$$;

-- The atomicity of the 3D quota lives in cre_reserve_3d_session; this wrapper
-- only adds the token gate and delegates, so there is exactly one reservation
-- implementation whichever credential path a deployment uses.
create or replace function public.cre_reserve_3d_session_tk(p_cap bigint, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
begin
  if not public.app_state_token_ok(p_token) then
    raise exception 'usage: token not registered' using errcode = '42501';
  end if;
  select to_jsonb(t) into v from public.cre_reserve_3d_session(p_cap) as t limit 1;
  return v;
end;
$$;

-- Revoke from the roles that actually hold the default grant, by name — the
-- Supabase ALTER DEFAULT PRIVILEGES lesson recorded in 202608150006 — then
-- grant the token-gated surface deliberately. anon/authenticated may EXECUTE
-- because the functions themselves refuse without a registered token, exactly
-- like app_state_get/app_state_put.
revoke all on function public.cre_usage_bump_tk(text, bigint, text) from public, anon, authenticated;
revoke all on function public.cre_usage_read_tk(text, text) from public, anon, authenticated;
revoke all on function public.cre_reserve_3d_session_tk(bigint, text) from public, anon, authenticated;

grant execute on function public.cre_usage_bump_tk(text, bigint, text) to anon, authenticated, service_role;
grant execute on function public.cre_usage_read_tk(text, text) to anon, authenticated, service_role;
grant execute on function public.cre_reserve_3d_session_tk(bigint, text) to anon, authenticated, service_role;
