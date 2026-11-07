-- Durable shared state reachable with a PUBLISHABLE key.
--
-- WHY THIS EXISTS
-- 202608140001_durable_app_state.sql creates public.app_state and expects the
-- server to reach it either with a direct Postgres connection (SUPABASE_DB_URL)
-- or with the service role. Neither credential exists on this deployment: the
-- project issues keys in the sb_publishable_/sb_secret_ format, which disables
-- the legacy JWT-signed API keys, so a service-role JWT cannot be minted from
-- SUPABASE_JWT_SECRET either. That was checked against the live project, not
-- assumed — and it is the reason /api/status reported
--   {"backend":"disk (no SUPABASE_DB_URL/DATABASE_URL)","survivesRedeploy":false}
-- while every save quietly went to a directory Render recreates on each deploy.
--
-- The one credential that IS available is the publishable key, which already
-- ships to the browser in public/js/supabase-env.js. A publishable key is public
-- by design, so it must never by itself grant write access to deployment-wide
-- state. This migration closes that gap: app_state keeps RLS on with no anon
-- policy, and the only way in is through SECURITY DEFINER functions that demand
-- a write token the server holds and the browser does not.
--
-- Idempotent, and safe to run against a project that already has app_state.

create table if not exists public.app_state (
  name       text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_state enable row level security;

-- Holds the sha-256 of each authorized write token. Never selectable by anon;
-- only the definer functions below read it.
create table if not exists public.app_state_auth (
  id         int primary key generated always as identity,
  token_sha  text not null,
  label      text,
  created_at timestamptz not null default now()
);
alter table public.app_state_auth enable row level security;

create extension if not exists pgcrypto;

create or replace function public.app_state_token_ok(p_token text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.app_state_auth
    where token_sha = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
  );
$$;

create or replace function public.app_state_get(p_name text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v jsonb;
begin
  if not public.app_state_token_ok(p_token) then
    raise exception 'app_state: invalid write token' using errcode = '42501';
  end if;
  select value into v from public.app_state where name = p_name;
  return v;
end;
$$;

create or replace function public.app_state_put(p_name text, p_value jsonb, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.app_state_token_ok(p_token) then
    raise exception 'app_state: invalid write token' using errcode = '42501';
  end if;
  insert into public.app_state (name, value, updated_at)
       values (p_name, p_value, now())
  on conflict (name) do update
      set value = excluded.value, updated_at = now();
  return p_value;
end;
$$;

-- Adopt-on-first-read: writes only when the row is absent, so a deployment that
-- already has state on disk carries its current board into the database instead
-- of resetting the user's work the moment durability is switched on.
create or replace function public.app_state_adopt(p_name text, p_value jsonb, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v jsonb;
begin
  if not public.app_state_token_ok(p_token) then
    raise exception 'app_state: invalid write token' using errcode = '42501';
  end if;
  insert into public.app_state (name, value)
       values (p_name, p_value)
  on conflict (name) do nothing;
  select value into v from public.app_state where name = p_name;
  return v;
end;
$$;

-- One-time token registration, so a fresh project needs no manual step and no
-- new secret in the hosting dashboard. Accepts a registration only while no
-- token exists: the first caller wins and the door closes permanently, so a
-- leaked publishable key cannot re-key the store afterwards. Re-registering the
-- same token is a no-op, which keeps a restart from being an error.
create or replace function public.app_state_bootstrap(p_token text, p_label text default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare n int;
begin
  if coalesce(length(p_token), 0) < 16 then
    raise exception 'app_state: bootstrap token too short' using errcode = '22023';
  end if;
  select count(*) into n from public.app_state_auth;
  if n > 0 then
    if public.app_state_token_ok(p_token) then
      return 'already-registered';
    end if;
    raise exception 'app_state: a write token is already registered' using errcode = '42501';
  end if;
  insert into public.app_state_auth (token_sha, label)
       values (encode(digest(p_token, 'sha256'), 'hex'), p_label);
  return 'registered';
end;
$$;

-- anon may call the guarded entry points and nothing else. In particular it may
-- not call app_state_token_ok directly, which would turn the function into a
-- token oracle.
--
-- REVOKE FROM PUBLIC, not just from anon. Postgres grants EXECUTE on a new
-- function to PUBLIC by default and anon inherits that, so revoking from anon
-- alone removes a grant it never separately held and the function stays callable
-- by every holder of the publishable key. Verified against the live project:
-- has_function_privilege('anon', 'app_state_open_bootstrap(int,text)', 'execute')
-- answered TRUE after the anon-only revoke and FALSE after this one.
revoke all on function public.app_state_token_ok(text) from public;
revoke all on function public.app_state_token_ok(text) from anon, authenticated;
grant execute on function public.app_state_get(text, text)          to anon, authenticated;
grant execute on function public.app_state_put(text, jsonb, text)   to anon, authenticated;
grant execute on function public.app_state_adopt(text, jsonb, text) to anon, authenticated;
grant execute on function public.app_state_bootstrap(text, text)    to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Bootstrap hardening.
--
-- The version above accepted the first sufficiently long token while
-- app_state_auth was empty, with a count(*) and an insert and nothing
-- serialising them. Two problems, both real:
--
--   * the publishable key is public by design, so any holder who reached the
--     RPC before the server did could claim the store;
--   * two concurrent first calls could both see an empty table and both insert.
--
-- Three guards, because no one of them is sufficient alone: a unique index on a
-- constant expression makes a second row impossible at the storage layer; a
-- transaction-scoped advisory lock serialises the check-then-insert; and
-- registration is closed by default, opened only by an operator-only function
-- for a bounded window that shuts the instant it is used.

create unique index if not exists app_state_auth_singleton
  on public.app_state_auth ((true));

create table if not exists public.app_state_bootstrap_window (
  id         boolean primary key default true constraint one_row check (id),
  open_until timestamptz not null,
  opened_by  text,
  created_at timestamptz not null default now()
);
alter table public.app_state_bootstrap_window enable row level security;

create or replace function public.app_state_open_bootstrap(p_minutes int default 15, p_who text default null)
returns timestamptz
language sql
security definer
set search_path = public, extensions
as $$
  insert into public.app_state_bootstrap_window (id, open_until, opened_by)
       values (true, now() + make_interval(mins => greatest(1, least(p_minutes, 120))), p_who)
  on conflict (id) do update
      set open_until = excluded.open_until, opened_by = excluded.opened_by
  returning open_until;
$$;
revoke all on function public.app_state_open_bootstrap(int, text) from public;
revoke all on function public.app_state_open_bootstrap(int, text) from anon, authenticated;

create or replace function public.app_state_bootstrap(p_token text, p_label text default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n int;
  win timestamptz;
begin
  if coalesce(length(p_token), 0) < 16 then
    raise exception 'app_state: bootstrap token too short' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('app_state_bootstrap'));

  select count(*) into n from public.app_state_auth;
  if n > 0 then
    if public.app_state_token_ok(p_token) then
      return 'already-registered';
    end if;
    raise exception 'app_state: a write token is already registered' using errcode = '42501';
  end if;

  select open_until into win from public.app_state_bootstrap_window where id;
  if win is null or win < now() then
    raise exception 'app_state: bootstrap is closed; an operator must call app_state_open_bootstrap() first'
      using errcode = '42501';
  end if;

  insert into public.app_state_auth (token_sha, label)
       values (encode(digest(p_token, 'sha256'), 'hex'), p_label);

  update public.app_state_bootstrap_window set open_until = now() - interval '1 second' where id;
  return 'registered';
end;
$$;

grant execute on function public.app_state_bootstrap(text, text) to anon, authenticated;
