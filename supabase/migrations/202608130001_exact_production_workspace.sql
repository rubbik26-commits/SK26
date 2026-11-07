-- NYC RE Market Intel exact-production workspace schema.
-- Idempotent where practical so it can be applied to the existing production
-- project or a replacement Supabase project without manual table editing.

create extension if not exists pgcrypto;

create table if not exists public.cre_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'user' check (role in ('user','owner','admin')),
  report_identity jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cre_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bbl text not null check (bbl ~ '^[0-9]{10}$'),
  address text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id,bbl)
);

create table if not exists public.cre_pipeline (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bbl text check (bbl is null or bbl ~ '^[0-9]{10}$'),
  address text,
  owner_entity text,
  stage text not null default 'Lead',
  distress_score numeric,
  propensity_score numeric,
  assessed_value numeric,
  last_sale jsonb,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists cre_pipeline_user_bbl_uq on public.cre_pipeline(user_id,bbl) where bbl is not null;
create index if not exists cre_pipeline_user_stage_idx on public.cre_pipeline(user_id,stage);

create table if not exists public.cre_pipeline_history (
  id bigint generated always as identity primary key,
  pipeline_id uuid not null references public.cre_pipeline(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  from_stage text,
  to_stage text not null,
  changed_at timestamptz not null default now()
);
create index if not exists cre_pipeline_history_pipeline_idx on public.cre_pipeline_history(pipeline_id,changed_at desc);

create table if not exists public.cre_canvass (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bbl text not null check (bbl ~ '^[0-9]{10}$'),
  address text,
  touch_type text not null,
  outcome text,
  note text,
  follow_up_date date,
  building_class text,
  ownership_duration_years numeric,
  distress_score numeric,
  propensity_score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cre_canvass_user_bbl_idx on public.cre_canvass(user_id,bbl,created_at desc);
create index if not exists cre_canvass_follow_up_idx on public.cre_canvass(user_id,follow_up_date) where follow_up_date is not null;

create table if not exists public.cre_investors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(data) = 'array')
);

-- Deployment-global paid-resource accounting. Service-role writes bypass RLS;
-- owner/admins can read it through the backend status endpoint.
create table if not exists public.cre_usage_daily (
  usage_date date not null,
  category text not null check (category in ('streetview','staticmap','photorealistic3d')),
  count bigint not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (usage_date,category)
);

create table if not exists public.cre_quota_daily (
  usage_date date not null,
  category text not null check (category in ('photorealistic3d')),
  used bigint not null default 0 check (used >= 0),
  hard_cap bigint not null default 25 check (hard_cap >= 0),
  updated_at timestamptz not null default now(),
  primary key (usage_date,category)
);

create or replace function public.cre_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.cre_profiles p
    where p.id = auth.uid() and p.role in ('owner','admin')
  );
$$;
revoke all on function public.cre_is_owner() from public;
grant execute on function public.cre_is_owner() to authenticated, service_role;

create or replace function public.cre_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create or replace function public.cre_pipeline_stage_history()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if old.stage is distinct from new.stage then
    insert into public.cre_pipeline_history(pipeline_id,user_id,from_stage,to_stage)
    values(new.id,new.user_id,old.stage,new.stage);
  end if;
  return new;
end $$;

-- Replace triggers deterministically.
drop trigger if exists cre_profiles_touch on public.cre_profiles;
create trigger cre_profiles_touch before update on public.cre_profiles for each row execute function public.cre_touch_updated_at();
drop trigger if exists cre_watchlist_touch on public.cre_watchlist;
create trigger cre_watchlist_touch before update on public.cre_watchlist for each row execute function public.cre_touch_updated_at();
drop trigger if exists cre_pipeline_touch on public.cre_pipeline;
create trigger cre_pipeline_touch before update on public.cre_pipeline for each row execute function public.cre_touch_updated_at();
drop trigger if exists cre_pipeline_stage_history on public.cre_pipeline;
create trigger cre_pipeline_stage_history after update of stage on public.cre_pipeline for each row execute function public.cre_pipeline_stage_history();
drop trigger if exists cre_canvass_touch on public.cre_canvass;
create trigger cre_canvass_touch before update on public.cre_canvass for each row execute function public.cre_touch_updated_at();
drop trigger if exists cre_investors_touch on public.cre_investors;
create trigger cre_investors_touch before update on public.cre_investors for each row execute function public.cre_touch_updated_at();

alter table public.cre_profiles enable row level security;
alter table public.cre_watchlist enable row level security;
alter table public.cre_pipeline enable row level security;
alter table public.cre_pipeline_history enable row level security;
alter table public.cre_canvass enable row level security;
alter table public.cre_investors enable row level security;
alter table public.cre_usage_daily enable row level security;
alter table public.cre_quota_daily enable row level security;

-- Profiles: users read their own row; owner/admins may read all. Normal users
-- cannot grant themselves owner/admin because INSERT requires role=user and the
-- role column is revoked from authenticated UPDATE below.
drop policy if exists cre_profiles_select on public.cre_profiles;
create policy cre_profiles_select on public.cre_profiles for select to authenticated using (id = auth.uid() or public.cre_is_owner());
drop policy if exists cre_profiles_insert on public.cre_profiles;
create policy cre_profiles_insert on public.cre_profiles for insert to authenticated with check (id = auth.uid() and role = 'user');
drop policy if exists cre_profiles_update on public.cre_profiles;
create policy cre_profiles_update on public.cre_profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Per-user workspace isolation.
drop policy if exists cre_watchlist_own on public.cre_watchlist;
create policy cre_watchlist_own on public.cre_watchlist for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists cre_pipeline_own on public.cre_pipeline;
create policy cre_pipeline_own on public.cre_pipeline for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists cre_pipeline_history_own on public.cre_pipeline_history;
create policy cre_pipeline_history_own on public.cre_pipeline_history for select to authenticated using (user_id = auth.uid());
drop policy if exists cre_canvass_own on public.cre_canvass;
create policy cre_canvass_own on public.cre_canvass for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists cre_investors_owner_own on public.cre_investors;
create policy cre_investors_owner_own on public.cre_investors for all to authenticated using (user_id = auth.uid() and public.cre_is_owner()) with check (user_id = auth.uid() and public.cre_is_owner());

-- Cost tables are not directly writable by browser users.
drop policy if exists cre_usage_owner_read on public.cre_usage_daily;
create policy cre_usage_owner_read on public.cre_usage_daily for select to authenticated using (public.cre_is_owner());
drop policy if exists cre_quota_owner_read on public.cre_quota_daily;
create policy cre_quota_owner_read on public.cre_quota_daily for select to authenticated using (public.cre_is_owner());

-- Table grants used by PostgREST. Do not grant browser access to quota writes.
grant select,insert,delete on public.cre_watchlist to authenticated;
grant update(address,metadata,updated_at) on public.cre_watchlist to authenticated;
grant select,insert,delete on public.cre_pipeline to authenticated;
grant update(address,owner_entity,stage,distress_score,propensity_score,assessed_value,last_sale,notes,metadata,updated_at) on public.cre_pipeline to authenticated;
grant select,insert,delete on public.cre_canvass to authenticated;
grant update(address,touch_type,outcome,note,follow_up_date,building_class,ownership_duration_years,distress_score,propensity_score,updated_at) on public.cre_canvass to authenticated;
grant select,insert,delete on public.cre_investors to authenticated;
grant update(data,updated_at) on public.cre_investors to authenticated;
grant select on public.cre_pipeline_history,public.cre_usage_daily,public.cre_quota_daily to authenticated;
grant select,insert on public.cre_profiles to authenticated;
revoke update on public.cre_profiles from authenticated;
grant update(display_name,report_identity,updated_at) on public.cre_profiles to authenticated;

-- Atomic durable 3D quota reservation. Only the server's service role may call
-- this; it returns false after the hard cap and is safe under concurrency.
create or replace function public.cre_reserve_3d_session(p_cap bigint default 25)
returns table(allowed boolean, used bigint, hard_cap bigint)
language plpgsql
security definer
set search_path=public
as $$
declare v_used bigint; v_cap bigint;
begin
  insert into public.cre_quota_daily(usage_date,category,used,hard_cap)
  values(current_date,'photorealistic3d',0,greatest(0,p_cap))
  on conflict (usage_date,category) do update set hard_cap=excluded.hard_cap,updated_at=now();

  update public.cre_quota_daily
  set used=used+1, updated_at=now()
  where usage_date=current_date and category='photorealistic3d' and used < hard_cap
  returning cre_quota_daily.used, cre_quota_daily.hard_cap into v_used,v_cap;

  if found then
    insert into public.cre_usage_daily(usage_date,category,count)
    values(current_date,'photorealistic3d',1)
    on conflict (usage_date,category) do update set count=cre_usage_daily.count+1,updated_at=now();
    return query select true,v_used,v_cap;
  end if;

  select q.used,q.hard_cap into v_used,v_cap from public.cre_quota_daily q
  where q.usage_date=current_date and q.category='photorealistic3d';
  return query select false,coalesce(v_used,0),coalesce(v_cap,greatest(0,p_cap));
end $$;
revoke all on function public.cre_reserve_3d_session(bigint) from public,anon,authenticated;
grant execute on function public.cre_reserve_3d_session(bigint) to service_role;

-- Atomic metering helper for server-side paid imagery requests.
create or replace function public.cre_increment_usage(p_category text,p_amount bigint default 1)
returns bigint
language plpgsql
security definer
set search_path=public
as $$
declare v_count bigint;
begin
  if p_category not in ('streetview','staticmap','photorealistic3d') then raise exception 'invalid category'; end if;
  insert into public.cre_usage_daily(usage_date,category,count)
  values(current_date,p_category,greatest(0,p_amount))
  on conflict (usage_date,category) do update set count=cre_usage_daily.count+greatest(0,p_amount),updated_at=now()
  returning count into v_count;
  return v_count;
end $$;
revoke all on function public.cre_increment_usage(text,bigint) from public,anon,authenticated;
grant execute on function public.cre_increment_usage(text,bigint) to service_role;
