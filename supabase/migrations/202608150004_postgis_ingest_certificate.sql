-- PostGIS ingestion certificate.
--
-- The warehouse is an acceleration layer over live NYC public records. It may
-- be preferred in production only after a COMPLETE citywide ingestion has
-- succeeded, including the post-migration ACRIS re-ingest required by the
-- (document_id,bbl) key repair. The certificate expires automatically; an old
-- warehouse then falls back to the live NYC adapters instead of remaining
-- authoritative indefinitely.

create table if not exists public.cre_ingest_certificate (
  id text primary key check (id = 'full_public_record_store'),
  completed_at timestamptz not null,
  expires_at timestamptz not null,
  full_documents boolean not null default false,
  schema_version text not null,
  scope jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.cre_ingest_certificate enable row level security;
revoke all on table public.cre_ingest_certificate from anon, authenticated;

-- Only the service role may certify a full ingest. The ingestion worker calls
-- this after every required worker completed successfully; a failed/partial run
-- never reaches this function.
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
begin
  insert into public.cre_ingest_certificate(
    id, completed_at, expires_at, full_documents, schema_version, scope, details, updated_at
  ) values (
    'full_public_record_store', now(), now() + interval '36 hours',
    p_full_documents, '202608150004', coalesce(p_scope, '{}'::jsonb),
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

-- Public status reveals no record data and no credential; it only answers
-- whether the warehouse is fresh enough to be trusted. Safe for the server to
-- call with a publishable key when that is the only configured PostgREST key.
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
        'fresh', c.expires_at > now() and c.full_documents and c.schema_version = '202608150004',
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
      'schemaVersion', '202608150004',
      'reason', 'no_complete_ingest_certificate'
    )
  );
$$;
revoke all on function public.postgis_store_status() from public;
grant execute on function public.postgis_store_status() to anon, authenticated, service_role;

-- This migration intentionally creates NO certificate row. Applying the schema
-- does not prove the data was repaired/refreshed. The first certificate must be
-- earned by a full citywide `npm run ingest` after this migration.
