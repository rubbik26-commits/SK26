-- Atomic full-ingest lifecycle.
--
-- A production warehouse must never remain certified while a new full refresh
-- is mutating it, reconciliation must not depend on wall-clock timing, and two
-- full refreshes must never overlap. A strict citywide run therefore:
--   1) acquires a renewable singleton lease and invalidates the old certificate
--      in the same database transaction BEFORE its first data write;
--   2) tags every row observed in that full snapshot with the lease UUID;
--   3) renews the lease while the long-running public-record crawl proceeds;
--   4) after every required source succeeds, deletes rows not tagged by that UUID;
--   5) only the active lease holder may issue a new freshness certificate.
--
-- Scoped/manual refreshes do not write full_sync_id, so they cannot accidentally
-- certify themselves or replace the identity of the last complete snapshot.

alter table public.parcels     add column if not exists full_sync_id uuid;
alter table public.acris_docs  add column if not exists full_sync_id uuid;
alter table public.dob_filings add column if not exists full_sync_id uuid;
alter table public.tax_bills   add column if not exists full_sync_id uuid;
alter table public.ntas        add column if not exists full_sync_id uuid;

create index if not exists parcels_full_sync_idx on public.parcels(full_sync_id);
create index if not exists acris_docs_full_sync_idx on public.acris_docs(full_sync_id);
create index if not exists dob_filings_full_sync_idx on public.dob_filings(full_sync_id);
create index if not exists tax_bills_full_sync_idx on public.tax_bills(full_sync_id);
create index if not exists ntas_full_sync_idx on public.ntas(full_sync_id);

create table if not exists public.cre_ingest_lock (
  id text primary key check (id = 'full_public_record_store'),
  full_sync_id uuid not null,
  acquired_at timestamptz not null,
  heartbeat_at timestamptz not null,
  expires_at timestamptz not null
);
alter table public.cre_ingest_lock enable row level security;
revoke all on table public.cre_ingest_lock from anon, authenticated;

-- Standalone emergency/operator invalidation. Normal full refreshes use
-- begin_full_ingest(), which performs this invalidation atomically with lease
-- acquisition so no competing refresh can slip between those operations.
create or replace function public.invalidate_full_ingest_certificate(
  p_reason text default 'full_refresh_started'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed integer := 0;
begin
  update public.cre_ingest_certificate
     set expires_at = least(expires_at, now()),
         details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
           'invalidatedAt', now(),
           'invalidatedReason', coalesce(nullif(p_reason, ''), 'full_refresh_started')
         ),
         updated_at = now()
   where id = 'full_public_record_store';
  get diagnostics v_changed = row_count;
  return jsonb_build_object('ok', true, 'invalidated', v_changed > 0);
end;
$$;
revoke all on function public.invalidate_full_ingest_certificate(text) from public;
grant execute on function public.invalidate_full_ingest_certificate(text) to service_role;

create or replace function public.begin_full_ingest(
  p_full_sync_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock public.cre_ingest_lock%rowtype;
  v_active public.cre_ingest_lock%rowtype;
begin
  if p_full_sync_id is null then raise exception 'p_full_sync_id is required'; end if;

  insert into public.cre_ingest_lock(id, full_sync_id, acquired_at, heartbeat_at, expires_at)
  values ('full_public_record_store', p_full_sync_id, now(), now(), now() + interval '20 minutes')
  on conflict (id) do update set
    full_sync_id = excluded.full_sync_id,
    acquired_at = excluded.acquired_at,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at
  where public.cre_ingest_lock.expires_at <= now()
     or public.cre_ingest_lock.full_sync_id = excluded.full_sync_id
  returning * into v_lock;

  if v_lock.id is null then
    select * into v_active
      from public.cre_ingest_lock
     where id = 'full_public_record_store';
    return jsonb_build_object(
      'acquired', false,
      'activeFullSyncId', v_active.full_sync_id,
      'expiresAt', v_active.expires_at,
      'reason', 'another_full_ingest_is_active'
    );
  end if;

  -- The certificate is invalidated in this same transaction as the successful
  -- lease acquisition. Production must fall back to live NYC data from the
  -- moment the first warehouse write of this refresh is allowed to begin.
  update public.cre_ingest_certificate
     set expires_at = least(expires_at, now()),
         details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
           'invalidatedAt', now(),
           'invalidatedReason', 'full_refresh_started',
           'refreshFullSyncId', p_full_sync_id
         ),
         updated_at = now()
   where id = 'full_public_record_store';

  return jsonb_build_object(
    'acquired', true,
    'fullSyncId', v_lock.full_sync_id,
    'expiresAt', v_lock.expires_at
  );
end;
$$;
revoke all on function public.begin_full_ingest(uuid) from public;
grant execute on function public.begin_full_ingest(uuid) to service_role;

create or replace function public.renew_full_ingest(
  p_full_sync_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock public.cre_ingest_lock%rowtype;
begin
  if p_full_sync_id is null then raise exception 'p_full_sync_id is required'; end if;
  update public.cre_ingest_lock
     set heartbeat_at = now(),
         expires_at = now() + interval '20 minutes'
   where id = 'full_public_record_store'
     and full_sync_id = p_full_sync_id
     and expires_at > now()
  returning * into v_lock;

  return jsonb_build_object(
    'renewed', v_lock.id is not null,
    'fullSyncId', p_full_sync_id,
    'expiresAt', v_lock.expires_at
  );
end;
$$;
revoke all on function public.renew_full_ingest(uuid) from public;
grant execute on function public.renew_full_ingest(uuid) to service_role;

create or replace function public.release_full_ingest(
  p_full_sync_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.cre_ingest_lock
   where id = 'full_public_record_store'
     and full_sync_id = p_full_sync_id;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('released', v_deleted = 1, 'fullSyncId', p_full_sync_id);
end;
$$;
revoke all on function public.release_full_ingest(uuid) from public;
grant execute on function public.release_full_ingest(uuid) to service_role;

-- MapPLUTO geometry writes use ingest_parcels(), so mark the successfully
-- upserted BBL batch separately rather than duplicating the geometry RPC.
create or replace function public.mark_parcel_full_sync(
  p_bbls text[],
  p_full_sync_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if p_full_sync_id is null then raise exception 'p_full_sync_id is required'; end if;
  if not exists (
    select 1 from public.cre_ingest_lock
     where id='full_public_record_store' and full_sync_id=p_full_sync_id and expires_at > now()
  ) then raise exception 'full ingest lease is not active'; end if;

  update public.parcels
     set full_sync_id = p_full_sync_id
   where bbl = any(coalesce(p_bbls, array[]::text[]));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.mark_parcel_full_sync(text[],uuid) from public;
grant execute on function public.mark_parcel_full_sync(text[],uuid) to service_role;

-- Same treatment for NTA geometry writes, which go through ingest_ntas().
create or replace function public.mark_nta_full_sync(
  p_nta_codes text[],
  p_full_sync_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if p_full_sync_id is null then raise exception 'p_full_sync_id is required'; end if;
  if not exists (
    select 1 from public.cre_ingest_lock
     where id='full_public_record_store' and full_sync_id=p_full_sync_id and expires_at > now()
  ) then raise exception 'full ingest lease is not active'; end if;

  update public.ntas
     set full_sync_id = p_full_sync_id
   where nta_code = any(coalesce(p_nta_codes, array[]::text[]));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.mark_nta_full_sync(text[],uuid) from public;
grant execute on function public.mark_nta_full_sync(text[],uuid) to service_role;

create or replace function public.reconcile_full_public_record_store(
  p_full_sync_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acris_deleted integer := 0;
  v_dob_deleted integer := 0;
  v_tax_deleted integer := 0;
  v_nta_deleted integer := 0;
  v_parcel_deleted integer := 0;
  v_parcels bigint := 0;
  v_acris bigint := 0;
  v_dob bigint := 0;
  v_tax bigint := 0;
  v_ntas bigint := 0;
begin
  if p_full_sync_id is null then raise exception 'p_full_sync_id is required'; end if;
  if not exists (
    select 1 from public.cre_ingest_lock
     where id='full_public_record_store' and full_sync_id=p_full_sync_id and expires_at > now()
  ) then raise exception 'full ingest lease is not active'; end if;

  -- Child/public-record tables first, then current parcel/NTA dimensions.
  delete from public.acris_docs where full_sync_id is distinct from p_full_sync_id;
  get diagnostics v_acris_deleted = row_count;

  delete from public.dob_filings where full_sync_id is distinct from p_full_sync_id;
  get diagnostics v_dob_deleted = row_count;

  delete from public.tax_bills where full_sync_id is distinct from p_full_sync_id;
  get diagnostics v_tax_deleted = row_count;

  delete from public.ntas where full_sync_id is distinct from p_full_sync_id;
  get diagnostics v_nta_deleted = row_count;

  delete from public.parcels where full_sync_id is distinct from p_full_sync_id;
  get diagnostics v_parcel_deleted = row_count;

  select count(*) into v_parcels from public.parcels;
  select count(*) into v_acris from public.acris_docs;
  select count(*) into v_dob from public.dob_filings;
  select count(*) into v_tax from public.tax_bills;
  select count(*) into v_ntas from public.ntas;

  return jsonb_build_object(
    'ok', true,
    'fullSyncId', p_full_sync_id,
    'deleted', jsonb_build_object(
      'acrisDocs', v_acris_deleted,
      'dobFilings', v_dob_deleted,
      'taxBills', v_tax_deleted,
      'ntas', v_nta_deleted,
      'parcels', v_parcel_deleted
    ),
    'remaining', jsonb_build_object(
      'parcels', v_parcels,
      'acrisDocs', v_acris,
      'dobFilings', v_dob,
      'taxBills', v_tax,
      'ntas', v_ntas
    )
  );
end;
$$;
revoke all on function public.reconcile_full_public_record_store(uuid) from public;
grant execute on function public.reconcile_full_public_record_store(uuid) to service_role;

-- Replace the 150004 certificate writer: after this migration, only the active
-- reconciled snapshot lease holder can certify and the certificate records the
-- current lifecycle schema version.
create or replace function public.mark_full_ingest_complete(
  p_scope jsonb default '{}'::jsonb,
  p_details jsonb default '{}'::jsonb,
  p_full_documents boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cre_ingest_certificate;
  v_sync_id uuid;
begin
  begin
    v_sync_id := nullif(p_scope->>'fullSyncId','')::uuid;
  exception when others then
    raise exception 'scope.fullSyncId must be a valid UUID';
  end;
  if v_sync_id is null then raise exception 'scope.fullSyncId is required'; end if;
  if coalesce((p_scope->>'reconciled')::boolean, false) is not true then
    raise exception 'scope.reconciled must be true';
  end if;
  if p_full_documents is not true then raise exception 'full document ingestion is required'; end if;
  if not exists (
    select 1 from public.cre_ingest_lock
     where id='full_public_record_store' and full_sync_id=v_sync_id and expires_at > now()
  ) then raise exception 'full ingest lease is not active'; end if;

  insert into public.cre_ingest_certificate(
    id, completed_at, expires_at, full_documents, schema_version, scope, details, updated_at
  ) values (
    'full_public_record_store', now(), now() + interval '36 hours',
    true, '202608150005', coalesce(p_scope, '{}'::jsonb),
    coalesce(p_details, '{}'::jsonb), now()
  )
  on conflict (id) do update set
    completed_at = excluded.completed_at,
    expires_at = excluded.expires_at,
    full_documents = excluded.full_documents,
    schema_version = excluded.schema_version,
    scope = excluded.scope,
    details = excluded.details,
    updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'fresh', v_row.expires_at > now() and v_row.full_documents,
    'completedAt', v_row.completed_at,
    'expiresAt', v_row.expires_at,
    'fullDocuments', v_row.full_documents,
    'schemaVersion', v_row.schema_version,
    'scope', v_row.scope,
    'details', v_row.details
  );
end;
$$;
revoke all on function public.mark_full_ingest_complete(jsonb,jsonb,boolean) from public;
grant execute on function public.mark_full_ingest_complete(jsonb,jsonb,boolean) to service_role;

create or replace function public.postgis_store_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'fresh',
          c.expires_at > now() and
          c.full_documents and
          c.schema_version = '202608150005' and
          coalesce((c.scope->>'reconciled')::boolean, false) and
          nullif(c.scope->>'fullSyncId','') is not null,
        'completedAt', c.completed_at,
        'expiresAt', c.expires_at,
        'fullDocuments', c.full_documents,
        'schemaVersion', c.schema_version,
        'scope', c.scope,
        'details', c.details
      )
      from public.cre_ingest_certificate c
      where c.id = 'full_public_record_store'
    ),
    jsonb_build_object(
      'fresh', false,
      'fullDocuments', false,
      'schemaVersion', '202608150005',
      'reason', 'no_complete_ingest_certificate'
    )
  );
$$;
revoke all on function public.postgis_store_status() from public;
grant execute on function public.postgis_store_status() to anon, authenticated, service_role;

-- Non-mutating proof for the deployment verifier.
create or replace function public.ingest_reconciliation_schema_check()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'ok',
      to_regclass('public.cre_ingest_lock') is not null and
      to_regprocedure('public.begin_full_ingest(uuid)') is not null and
      to_regprocedure('public.renew_full_ingest(uuid)') is not null and
      to_regprocedure('public.release_full_ingest(uuid)') is not null and
      to_regprocedure('public.mark_parcel_full_sync(text[],uuid)') is not null and
      to_regprocedure('public.mark_nta_full_sync(text[],uuid)') is not null and
      to_regprocedure('public.reconcile_full_public_record_store(uuid)') is not null and
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='parcels' and column_name='full_sync_id') and
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='acris_docs' and column_name='full_sync_id') and
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='dob_filings' and column_name='full_sync_id') and
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='tax_bills' and column_name='full_sync_id') and
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='ntas' and column_name='full_sync_id'),
    'functions', jsonb_build_object(
      'begin', to_regprocedure('public.begin_full_ingest(uuid)') is not null,
      'renew', to_regprocedure('public.renew_full_ingest(uuid)') is not null,
      'release', to_regprocedure('public.release_full_ingest(uuid)') is not null,
      'markParcels', to_regprocedure('public.mark_parcel_full_sync(text[],uuid)') is not null,
      'markNtas', to_regprocedure('public.mark_nta_full_sync(text[],uuid)') is not null,
      'reconcile', to_regprocedure('public.reconcile_full_public_record_store(uuid)') is not null
    ),
    'fullSyncColumns', jsonb_build_object(
      'parcels', exists(select 1 from information_schema.columns where table_schema='public' and table_name='parcels' and column_name='full_sync_id'),
      'acrisDocs', exists(select 1 from information_schema.columns where table_schema='public' and table_name='acris_docs' and column_name='full_sync_id'),
      'dobFilings', exists(select 1 from information_schema.columns where table_schema='public' and table_name='dob_filings' and column_name='full_sync_id'),
      'taxBills', exists(select 1 from information_schema.columns where table_schema='public' and table_name='tax_bills' and column_name='full_sync_id'),
      'ntas', exists(select 1 from information_schema.columns where table_schema='public' and table_name='ntas' and column_name='full_sync_id')
    )
  );
$$;
revoke all on function public.ingest_reconciliation_schema_check() from public;
grant execute on function public.ingest_reconciliation_schema_check() to anon, authenticated, service_role;

-- Applying this migration never creates a certificate. The first 150005
-- certificate must be earned by a serialized, complete, reconciled citywide run.
