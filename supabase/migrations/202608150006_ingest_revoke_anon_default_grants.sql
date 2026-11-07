-- Close the `anon`/`authenticated` grants Supabase attached to the PostGIS
-- ingest RPCs at creation time.
--
-- WHAT WAS WRONG
-- 202608130003, 202608150004 and 202608150005 each end with
-- `revoke ... from public` followed by `grant execute ... to service_role`, and
-- each says in its own comment that the function is service-role-only. Verified
-- against the live project after applying all three, every one of these ten
-- SECURITY DEFINER writers answered TRUE to
-- has_function_privilege('anon', ..., 'execute').
--
-- This is the same defect already documented in
-- 202608150004_cre_revoke_anon_default_grants.sql, one layer deeper: a Supabase
-- project ships ALTER DEFAULT PRIVILEGES that grant EXECUTE to anon and
-- authenticated on every function created in `public`. Those are direct grants
-- held by the roles themselves, so `revoke ... from public` — which only drops
-- the PUBLIC pseudo-role's grant — removes nothing. A privilege has to be
-- revoked from the role that actually holds it.
--
-- IMPACT
-- Unlike the cre_* table grants, RLS is not a second line of defence here.
-- These are SECURITY DEFINER functions: they execute as their owner and bypass
-- row-level security by design, and none of them consults auth.uid(). With the
-- publishable key — which is public by design and already embedded in the
-- compiled frontend — an anonymous caller could:
--
--   * ingest_parcels(jsonb) / ingest_ntas(jsonb): upsert arbitrary rows into
--     public.parcels and public.ntas. Fabricated lot area, FAR, owner of record
--     and assessed value would then be served as authoritative public record.
--   * begin_full_ingest(uuid): acquire the singleton lease with any UUID. It is
--     the one lifecycle function with no lease precondition, so holding it
--     unlocks every function below that checks for "an active lease".
--   * reconcile_full_public_record_store(uuid): delete every row in parcels,
--     acris_docs, dob_filings, tax_bills and ntas not tagged with that UUID.
--   * mark_full_ingest_complete(...): certify a warehouse that was never
--     ingested, so a POSTGIS_TRUSTED deployment would prefer it over live NYC
--     sources.
--
-- The public read surface (lot_at, nta_polys, assemblage_at,
-- parcels_opportunities, tax_history_at, parcel_contacts, postgis_store_status,
-- release_schema_check, ingest_reconciliation_schema_check) is deliberately left
-- exactly as it is. This file only removes access the schema never intended to
-- hand out, and restates the intended service_role grant unchanged.

revoke execute on function public.ingest_parcels(jsonb)                        from public, anon, authenticated;
revoke execute on function public.ingest_ntas(jsonb)                           from public, anon, authenticated;
revoke execute on function public.mark_full_ingest_complete(jsonb,jsonb,boolean) from public, anon, authenticated;
revoke execute on function public.invalidate_full_ingest_certificate(text)     from public, anon, authenticated;
revoke execute on function public.begin_full_ingest(uuid)                      from public, anon, authenticated;
revoke execute on function public.renew_full_ingest(uuid)                      from public, anon, authenticated;
revoke execute on function public.release_full_ingest(uuid)                    from public, anon, authenticated;
revoke execute on function public.mark_parcel_full_sync(text[],uuid)           from public, anon, authenticated;
revoke execute on function public.mark_nta_full_sync(text[],uuid)              from public, anon, authenticated;
revoke execute on function public.reconcile_full_public_record_store(uuid)     from public, anon, authenticated;

grant execute on function public.ingest_parcels(jsonb)                          to service_role;
grant execute on function public.ingest_ntas(jsonb)                             to service_role;
grant execute on function public.mark_full_ingest_complete(jsonb,jsonb,boolean) to service_role;
grant execute on function public.invalidate_full_ingest_certificate(text)       to service_role;
grant execute on function public.begin_full_ingest(uuid)                        to service_role;
grant execute on function public.renew_full_ingest(uuid)                        to service_role;
grant execute on function public.release_full_ingest(uuid)                      to service_role;
grant execute on function public.mark_parcel_full_sync(text[],uuid)             to service_role;
grant execute on function public.mark_nta_full_sync(text[],uuid)                to service_role;
grant execute on function public.reconcile_full_public_record_store(uuid)       to service_role;

-- Future functions created in `public` inherit the same default grant, so stop
-- handing it out rather than relying on every migration to remember the revoke.
-- This changes nothing that already exists; it only applies to objects created
-- from here on, by the role that owns the migrations.
alter default privileges in schema public revoke execute on functions from anon;

-- ------------------------------------------------------- fail closed on regress
-- Extend the release check (202608150003_finishline_authority_release.sql) with
-- the grant assertions. scripts/verify-production-schema.mjs already fails the
-- deploy on any false value in a nested object of this result, so each entry is
-- phrased positively: TRUE means "correctly locked down".
--
-- Restated in full rather than patched, because a Postgres function has no
-- partial replacement. Every table, column, key and function assertion from
-- 202608150003 is carried forward here verbatim; only the 'grants' block is new.
create or replace function public.release_schema_check()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
declare
  acris_pk_ok boolean := false;
  grants_ok boolean := false;
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

  -- A missing function is not a passing grant check. to_regprocedure returns
  -- NULL when the function does not exist, and has_function_privilege would
  -- raise on NULL, so absence is reported as "not locked down" rather than
  -- crashing the check the deploy gate depends on.
  select
    not coalesce(has_function_privilege('anon', to_regprocedure('public.ingest_parcels(jsonb)'), 'execute'), true) and
    not coalesce(has_function_privilege('anon', to_regprocedure('public.ingest_ntas(jsonb)'), 'execute'), true) and
    not coalesce(has_function_privilege('anon', to_regprocedure('public.begin_full_ingest(uuid)'), 'execute'), true) and
    not coalesce(has_function_privilege('anon', to_regprocedure('public.reconcile_full_public_record_store(uuid)'), 'execute'), true) and
    not coalesce(has_function_privilege('anon', to_regprocedure('public.mark_full_ingest_complete(jsonb,jsonb,boolean)'), 'execute'), true)
  into grants_ok;

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
      acris_pk_ok and
      grants_ok,
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
    ),
    -- TRUE means the anonymous role CANNOT reach that writer.
    'grants', jsonb_build_object(
      'anon_locked_out_of_ingest_parcels', not coalesce(has_function_privilege('anon', to_regprocedure('public.ingest_parcels(jsonb)'), 'execute'), true),
      'anon_locked_out_of_ingest_ntas', not coalesce(has_function_privilege('anon', to_regprocedure('public.ingest_ntas(jsonb)'), 'execute'), true),
      'anon_locked_out_of_begin_full_ingest', not coalesce(has_function_privilege('anon', to_regprocedure('public.begin_full_ingest(uuid)'), 'execute'), true),
      'anon_locked_out_of_renew_full_ingest', not coalesce(has_function_privilege('anon', to_regprocedure('public.renew_full_ingest(uuid)'), 'execute'), true),
      'anon_locked_out_of_release_full_ingest', not coalesce(has_function_privilege('anon', to_regprocedure('public.release_full_ingest(uuid)'), 'execute'), true),
      'anon_locked_out_of_mark_parcel_full_sync', not coalesce(has_function_privilege('anon', to_regprocedure('public.mark_parcel_full_sync(text[],uuid)'), 'execute'), true),
      'anon_locked_out_of_mark_nta_full_sync', not coalesce(has_function_privilege('anon', to_regprocedure('public.mark_nta_full_sync(text[],uuid)'), 'execute'), true),
      'anon_locked_out_of_reconcile', not coalesce(has_function_privilege('anon', to_regprocedure('public.reconcile_full_public_record_store(uuid)'), 'execute'), true),
      'anon_locked_out_of_mark_full_ingest_complete', not coalesce(has_function_privilege('anon', to_regprocedure('public.mark_full_ingest_complete(jsonb,jsonb,boolean)'), 'execute'), true),
      'anon_locked_out_of_invalidate_certificate', not coalesce(has_function_privilege('anon', to_regprocedure('public.invalidate_full_ingest_certificate(text)'), 'execute'), true),
      'authenticated_locked_out_of_ingest_parcels', not coalesce(has_function_privilege('authenticated', to_regprocedure('public.ingest_parcels(jsonb)'), 'execute'), true),
      'authenticated_locked_out_of_reconcile', not coalesce(has_function_privilege('authenticated', to_regprocedure('public.reconcile_full_public_record_store(uuid)'), 'execute'), true),
      -- The public read surface must stay reachable; a revoke that overshoots
      -- would blank the map and the dossier instead of failing loudly.
      'anon_can_read_lot_at', coalesce(has_function_privilege('anon', to_regprocedure('public.lot_at(double precision,double precision)'), 'execute'), false),
      'anon_can_read_assemblage_at', coalesce(has_function_privilege('anon', to_regprocedure('public.assemblage_at(text)'), 'execute'), false),
      'anon_can_read_parcels_opportunities', coalesce(has_function_privilege('anon', to_regprocedure('public.parcels_opportunities(text[],integer)'), 'execute'), false),
      'anon_can_read_postgis_store_status', coalesce(has_function_privilege('anon', to_regprocedure('public.postgis_store_status()'), 'execute'), false)
    )
  );
  return result;
end;
$$;

revoke all on function public.release_schema_check() from public;
grant execute on function public.release_schema_check() to anon, authenticated, service_role;
