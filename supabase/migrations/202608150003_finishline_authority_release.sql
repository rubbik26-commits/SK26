-- Authority-release schema guarantees.
--
-- 1) Pipeline rows may persist the BBL derived from the opportunity id.
-- 2) Assemblage means a contiguous same-owner cluster, not merely "same block".
-- 3) release_schema_check() gives a deploy using only a publishable key a safe,
--    non-secret way to prove the required schema objects are actually present.

-- ---------------------------------------------------------------- pipeline BBL
-- Existing RLS still limits rows to auth.uid(); this only adds the column to the
-- authenticated UPDATE grant so an existing kanban card can be backfilled.
grant update(bbl) on public.cre_pipeline to authenticated;

-- --------------------------------------------------------- strict assemblage
create or replace function public.assemblage_at(p_bbl text)
returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  with recursive subject as (
    select * from public.parcels where bbl = p_bbl
  ),
  connected(bbl) as (
    select s.bbl from subject s
    union
    select p.bbl
      from connected c
      join public.parcels current_lot on current_lot.bbl = c.bbl
      join subject s on true
      join public.parcels p
        on p.bbl <> current_lot.bbl
       and p.borough = s.borough
       and p.block = s.block
       and coalesce(p.owner_name, '') <> ''
       and p.owner_name = s.owner_name
       and p.geom is not null
       and current_lot.geom is not null
       and st_touches(p.geom, current_lot.geom)
  ),
  cluster as (
    select p.*,
           case
             when p.bbl = s.bbl then true
             when p.geom is not null and s.geom is not null then st_touches(p.geom, s.geom)
             else false
           end as touches_subject
      from connected c
      join public.parcels p on p.bbl = c.bbl
      join subject s on true
  )
  select jsonb_build_object(
    'owner', s.owner_name,
    'count', (select count(*) from cluster),
    'subjectUnusedSf', greatest(0, round(coalesce(s.lot_area, 0) *
        greatest(0, greatest(coalesce(s.resid_far, 0), coalesce(s.comm_far, 0)) - coalesce(s.built_far, 0)))),
    'lots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bbl', c.bbl,
        'address', coalesce(c.address, '—'),
        'lotArea', coalesce(c.lot_area, 0),
        'builtFar', coalesce(c.built_far, 0),
        'maxFar', greatest(coalesce(c.resid_far, 0), coalesce(c.comm_far, 0)),
        'unusedSf', greatest(0, round(coalesce(c.lot_area, 0) *
            greatest(0, greatest(coalesce(c.resid_far, 0), coalesce(c.comm_far, 0)) - coalesce(c.built_far, 0)))),
        'touches', coalesce(c.touches_subject, false)
      ) order by c.bbl)
      from cluster c
    ), '[]'::jsonb)
  )
  from subject s;
$$;

revoke all on function public.assemblage_at(text) from public;
grant execute on function public.assemblage_at(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------- schema release RPC
create or replace function public.release_schema_check()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
declare
  acris_pk_ok boolean := false;
  result jsonb;
begin
  select exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'acris_docs'
       and c.contype = 'p'
       and (
         select array_agg(a.attname order by u.ord)
           from unnest(c.conkey) with ordinality u(attnum, ord)
           join pg_attribute a on a.attrelid = t.oid and a.attnum = u.attnum
       ) = array['document_id','bbl']::name[]
  ) into acris_pk_ok;

  result := jsonb_build_object(
    'ok',
      to_regclass('public.cre_profiles') is not null and
      to_regclass('public.cre_pipeline') is not null and
      to_regclass('public.cre_investors') is not null and
      to_regclass('public.cre_usage_daily') is not null and
      to_regclass('public.cre_quota_daily') is not null and
      to_regclass('public.app_state') is not null and
      to_regclass('public.parcels') is not null and
      to_regclass('public.acris_docs') is not null and
      to_regclass('public.dob_filings') is not null and
      to_regclass('public.tax_bills') is not null and
      to_regclass('public.ntas') is not null and
      acris_pk_ok,
    'tables', jsonb_build_object(
      'cre_profiles', to_regclass('public.cre_profiles') is not null,
      'cre_pipeline', to_regclass('public.cre_pipeline') is not null,
      'cre_investors', to_regclass('public.cre_investors') is not null,
      'cre_usage_daily', to_regclass('public.cre_usage_daily') is not null,
      'cre_quota_daily', to_regclass('public.cre_quota_daily') is not null,
      'app_state', to_regclass('public.app_state') is not null,
      'parcels', to_regclass('public.parcels') is not null,
      'acris_docs', to_regclass('public.acris_docs') is not null,
      'dob_filings', to_regclass('public.dob_filings') is not null,
      'tax_bills', to_regclass('public.tax_bills') is not null,
      'ntas', to_regclass('public.ntas') is not null
    ),
    'columns', jsonb_build_object(
      'pipeline_bbl', exists(select 1 from information_schema.columns where table_schema='public' and table_name='cre_pipeline' and column_name='bbl'),
      'usage_date', exists(select 1 from information_schema.columns where table_schema='public' and table_name='cre_usage_daily' and column_name='usage_date'),
      'usage_count', exists(select 1 from information_schema.columns where table_schema='public' and table_name='cre_usage_daily' and column_name='count')
    ),
    'keys', jsonb_build_object('acris_document_bbl_pk', acris_pk_ok),
    'functions', jsonb_build_object(
      'app_state_get', to_regprocedure('public.app_state_get(text,text)') is not null,
      'app_state_put', to_regprocedure('public.app_state_put(text,jsonb,text)') is not null,
      'cre_increment_usage', to_regprocedure('public.cre_increment_usage(text,bigint)') is not null,
      'cre_reserve_3d_session', to_regprocedure('public.cre_reserve_3d_session(bigint)') is not null,
      'lot_at', to_regprocedure('public.lot_at(double precision,double precision)') is not null,
      'assemblage_at', to_regprocedure('public.assemblage_at(text)') is not null,
      'parcels_opportunities', to_regprocedure('public.parcels_opportunities(text[],integer)') is not null
    )
  );
  return result;
end;
$$;

-- This RPC reveals only schema presence/shape, never row data or secrets. It is
-- intentionally callable with the publishable/anon key so a Render build that
-- has no direct database URI can still fail closed on a partial migration.
revoke all on function public.release_schema_check() from public;
grant execute on function public.release_schema_check() to anon, authenticated, service_role;
