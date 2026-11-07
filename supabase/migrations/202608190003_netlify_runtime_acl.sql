-- Restore the Netlify scraper runtime contract without exposing warehouse tables or
-- the legacy unprotected request RPC. The Netlify functions authenticate with a
-- high-entropy shared secret whose SHA-256 verifier is stored in
-- public.sbi_runtime_config; the plaintext credential remains only in Netlify.
--
-- Intentional security-advisor exception:
-- the ten outer RPCs below are SECURITY DEFINER and callable by anon because
-- PostgREST maps a publishable key to that role. Every outer RPC must pass through
-- public.sbi_runtime_secret_ok(), authenticated is explicitly denied, the
-- validator itself remains private, and untrusted roles cannot CREATE in public.
-- No sbi_* table row is inserted, updated, merged, or deleted by this migration.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $runtime_contract$
declare
  v_missing text[];
begin
  select array_agg(expected.signature order by expected.signature)
  into v_missing
  from (
    values
      ('public.sbi_runtime_request_run(text,text,text,jsonb)'),
      ('public.sbi_runtime_active_run(text,text,integer)'),
      ('public.sbi_runtime_update_run(text,uuid,text,jsonb,text)'),
      ('public.sbi_runtime_rolling_targets(text,integer)'),
      ('public.sbi_runtime_rolling_apply(text,uuid,integer,integer,jsonb)'),
      ('public.sbi_runtime_phase2_targets(text,integer)'),
      ('public.sbi_runtime_phase2_apply(text,uuid,text,numeric,date,text,text,text,text)'),
      ('public.sbi_runtime_sync(text,jsonb)'),
      ('public.sbi_runtime_broker_contacts(text,jsonb)'),
      ('public.sbi_runtime_log_ai(text,text,text,text,text,integer,integer,integer,text,text)')
  ) as expected(signature)
  where to_regprocedure(expected.signature) is null;

  if v_missing is not null then
    raise exception 'Netlify runtime migration is incomplete; missing functions: %', v_missing;
  end if;

  if exists (
    select 1
    from (
      values
        ('public.sbi_runtime_request_run(text,text,text,jsonb)'),
        ('public.sbi_runtime_active_run(text,text,integer)'),
        ('public.sbi_runtime_update_run(text,uuid,text,jsonb,text)'),
        ('public.sbi_runtime_rolling_targets(text,integer)'),
        ('public.sbi_runtime_rolling_apply(text,uuid,integer,integer,jsonb)'),
        ('public.sbi_runtime_phase2_targets(text,integer)'),
        ('public.sbi_runtime_phase2_apply(text,uuid,text,numeric,date,text,text,text,text)'),
        ('public.sbi_runtime_sync(text,jsonb)'),
        ('public.sbi_runtime_broker_contacts(text,jsonb)'),
        ('public.sbi_runtime_log_ai(text,text,text,text,text,integer,integer,integer,text,text)')
    ) as expected(signature)
    join pg_proc p on p.oid = to_regprocedure(expected.signature)
    where p.prosecdef is not true
       or coalesce(p.proconfig @> array['search_path=public'], false) is not true
       or position('public.sbi_runtime_secret_ok' in pg_get_functiondef(p.oid)) = 0
  ) then
    raise exception 'Netlify runtime functions must remain SECURITY DEFINER, fixed to public, and secret-gated';
  end if;

  if not exists (
    select 1
    from pg_proc p
    where p.oid = to_regprocedure('public.sbi_runtime_secret_ok(text)')
      and p.prosecdef is true
      and coalesce(p.proconfig @> array['search_path=public, extensions'], false) is true
  ) then
    raise exception 'The private Netlify runtime secret validator is missing or unsafe';
  end if;

  if has_schema_privilege('public', 'public', 'CREATE')
     or has_schema_privilege('anon', 'public', 'CREATE')
     or has_schema_privilege('authenticated', 'public', 'CREATE') then
    raise exception 'The fixed public search_path is unsafe while an untrusted role can CREATE in public';
  end if;
end
$runtime_contract$;

revoke all on function
  public.sbi_runtime_request_run(text,text,text,jsonb),
  public.sbi_runtime_active_run(text,text,integer),
  public.sbi_runtime_update_run(text,uuid,text,jsonb,text),
  public.sbi_runtime_rolling_targets(text,integer),
  public.sbi_runtime_rolling_apply(text,uuid,integer,integer,jsonb),
  public.sbi_runtime_phase2_targets(text,integer),
  public.sbi_runtime_phase2_apply(text,uuid,text,numeric,date,text,text,text,text),
  public.sbi_runtime_sync(text,jsonb),
  public.sbi_runtime_broker_contacts(text,jsonb),
  public.sbi_runtime_log_ai(text,text,text,text,text,integer,integer,integer,text,text)
from public, anon, authenticated;

grant execute on function
  public.sbi_runtime_request_run(text,text,text,jsonb),
  public.sbi_runtime_active_run(text,text,integer),
  public.sbi_runtime_update_run(text,uuid,text,jsonb,text),
  public.sbi_runtime_rolling_targets(text,integer),
  public.sbi_runtime_rolling_apply(text,uuid,integer,integer,jsonb),
  public.sbi_runtime_phase2_targets(text,integer),
  public.sbi_runtime_phase2_apply(text,uuid,text,numeric,date,text,text,text,text),
  public.sbi_runtime_sync(text,jsonb),
  public.sbi_runtime_broker_contacts(text,jsonb),
  public.sbi_runtime_log_ai(text,text,text,text,text,integer,integer,integer,text,text)
to anon, service_role;

-- The validator and the obsolete direct request endpoint are not public APIs.
revoke all on function public.sbi_runtime_secret_ok(text)
from public, anon, authenticated;
grant execute on function public.sbi_runtime_secret_ok(text) to service_role;

revoke all on function public.api_request_scrape(text,text,jsonb)
from public, anon, authenticated;
grant execute on function public.api_request_scrape(text,text,jsonb) to service_role;

create or replace function public.netlify_runtime_schema_check()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $schema_check$
declare
  v_expected integer;
  v_present integer;
  v_security_definer boolean;
  v_fixed_search_path boolean;
  v_secret_gate boolean;
  v_anon_all boolean;
  v_authenticated_any boolean;
  v_service_role_all boolean;
  v_secret_oid oid;
  v_legacy_oid oid;
  v_secret_private boolean;
  v_legacy_private boolean;
  v_public_schema_safe boolean;
  v_ok boolean;
begin
  with expected(signature) as (
    values
      ('public.sbi_runtime_request_run(text,text,text,jsonb)'),
      ('public.sbi_runtime_active_run(text,text,integer)'),
      ('public.sbi_runtime_update_run(text,uuid,text,jsonb,text)'),
      ('public.sbi_runtime_rolling_targets(text,integer)'),
      ('public.sbi_runtime_rolling_apply(text,uuid,integer,integer,jsonb)'),
      ('public.sbi_runtime_phase2_targets(text,integer)'),
      ('public.sbi_runtime_phase2_apply(text,uuid,text,numeric,date,text,text,text,text)'),
      ('public.sbi_runtime_sync(text,jsonb)'),
      ('public.sbi_runtime_broker_contacts(text,jsonb)'),
      ('public.sbi_runtime_log_ai(text,text,text,text,text,integer,integer,integer,text,text)')
  ),
  resolved as (
    select expected.signature, pg_catalog.to_regprocedure(expected.signature) as oid
    from expected
  )
  select
    count(*)::integer,
    count(resolved.oid)::integer,
    coalesce(bool_and(p.prosecdef), false),
    coalesce(bool_and(p.proconfig @> array['search_path=public']), false),
    coalesce(bool_and(
      resolved.oid is not null
      and position('public.sbi_runtime_secret_ok' in pg_catalog.pg_get_functiondef(resolved.oid)) > 0
    ), false),
    coalesce(bool_and(pg_catalog.has_function_privilege('anon', resolved.oid, 'EXECUTE')), false),
    coalesce(bool_or(pg_catalog.has_function_privilege('authenticated', resolved.oid, 'EXECUTE')), false),
    coalesce(bool_and(pg_catalog.has_function_privilege('service_role', resolved.oid, 'EXECUTE')), false)
  into
    v_expected,
    v_present,
    v_security_definer,
    v_fixed_search_path,
    v_secret_gate,
    v_anon_all,
    v_authenticated_any,
    v_service_role_all
  from resolved
  left join pg_catalog.pg_proc p on p.oid = resolved.oid;

  v_secret_oid := pg_catalog.to_regprocedure('public.sbi_runtime_secret_ok(text)');
  v_legacy_oid := pg_catalog.to_regprocedure('public.api_request_scrape(text,text,jsonb)');

  v_secret_private :=
    v_secret_oid is not null
    and not pg_catalog.has_function_privilege('anon', v_secret_oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', v_secret_oid, 'EXECUTE')
    and pg_catalog.has_function_privilege('service_role', v_secret_oid, 'EXECUTE');

  v_legacy_private :=
    v_legacy_oid is not null
    and not pg_catalog.has_function_privilege('anon', v_legacy_oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', v_legacy_oid, 'EXECUTE')
    and pg_catalog.has_function_privilege('service_role', v_legacy_oid, 'EXECUTE');

  v_public_schema_safe :=
    not pg_catalog.has_schema_privilege('public', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('anon', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('authenticated', 'public', 'CREATE');

  v_ok :=
    v_expected = 10
    and v_present = v_expected
    and v_security_definer
    and v_fixed_search_path
    and v_secret_gate
    and v_anon_all
    and not v_authenticated_any
    and v_service_role_all
    and v_secret_private
    and v_legacy_private
    and v_public_schema_safe;

  return pg_catalog.jsonb_build_object(
    'ok', v_ok,
    'revision', '202608190003_netlify_runtime_acl',
    'runtimeFunctions', pg_catalog.jsonb_build_object(
      'expected', v_expected,
      'present', v_present,
      'securityDefinerAll', v_security_definer,
      'fixedSearchPathAll', v_fixed_search_path,
      'secretGateAll', v_secret_gate,
      'anonExecuteAll', v_anon_all,
      'authenticatedExecuteAny', v_authenticated_any,
      'serviceRoleExecuteAll', v_service_role_all
    ),
    'secretValidator', pg_catalog.jsonb_build_object(
      'anonExecute', pg_catalog.has_function_privilege('anon', v_secret_oid, 'EXECUTE'),
      'authenticatedExecute', pg_catalog.has_function_privilege('authenticated', v_secret_oid, 'EXECUTE'),
      'serviceRoleExecute', pg_catalog.has_function_privilege('service_role', v_secret_oid, 'EXECUTE')
    ),
    'legacyRequest', pg_catalog.jsonb_build_object(
      'anonExecute', pg_catalog.has_function_privilege('anon', v_legacy_oid, 'EXECUTE'),
      'authenticatedExecute', pg_catalog.has_function_privilege('authenticated', v_legacy_oid, 'EXECUTE'),
      'serviceRoleExecute', pg_catalog.has_function_privilege('service_role', v_legacy_oid, 'EXECUTE')
    ),
    'publicSchema', pg_catalog.jsonb_build_object(
      'publicCreate', pg_catalog.has_schema_privilege('public', 'public', 'CREATE'),
      'anonCreate', pg_catalog.has_schema_privilege('anon', 'public', 'CREATE'),
      'authenticatedCreate', pg_catalog.has_schema_privilege('authenticated', 'public', 'CREATE')
    )
  );
end
$schema_check$;

revoke all on function public.netlify_runtime_schema_check()
from public, anon, authenticated;
grant execute on function public.netlify_runtime_schema_check() to service_role;

comment on function public.netlify_runtime_schema_check() is
  'Read-only deployment certificate for the shared-secret Netlify scraper runtime ACL.';

notify pgrst, 'reload schema';

commit;

