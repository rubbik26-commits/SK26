-- Add a read-only operational contract for buyerDB refreshes.
--
-- This migration does not transform, delete, or backfill buyer data. Lucia's
-- buyer rankings continue to read the canonical sbi_* warehouse through
-- api_buyers/api_entity. The function below only reports freshness and the
-- existing address-integrity certificate so a stalled refresh cannot look
-- healthy merely because historical rows still exist.

create index if not exists sbi_source_runs_job_status_activity_idx
  on public.sbi_source_runs (job, status, started_at desc, finished_at desc);

create or replace function public.buyer_intelligence_refresh_status()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  with required_jobs(job, max_age_hours, display_order) as (
    values
      ('acris_refresh'::text, 36::integer, 1::integer),
      ('traded_refresh'::text, 36::integer, 2::integer),
      ('rolling_sales'::text, 36::integer, 3::integer),
      ('crexi_refresh'::text, 36::integer, 4::integer),
      ('phase2_enrichment'::text, 192::integer, 5::integer),
      ('dos_enrich'::text, 192::integer, 6::integer),
      ('property_owner_refresh'::text, 192::integer, 7::integer)
  ),
  per_job as (
    select
      required.job,
      required.max_age_hours,
      required.display_order,
      latest.run_id as latest_run_id,
      latest.source as latest_source,
      latest.status as latest_status,
      latest.started_at as latest_started_at,
      latest.finished_at as latest_finished_at,
      (latest.error is not null) as latest_has_error,
      coalesce(success.finished_at, success.started_at) as last_successful_at,
      (
        coalesce(success.finished_at, success.started_at) is not null
        and coalesce(success.finished_at, success.started_at)
          >= pg_catalog.now() - pg_catalog.make_interval(hours => required.max_age_hours)
      ) as fresh,
      (
        select pg_catalog.count(*)::integer
        from public.sbi_source_runs stuck
        where stuck.job = required.job
          and stuck.status in ('requested', 'running')
          and stuck.started_at < pg_catalog.now() - interval '2 hours'
      ) as stuck_runs
    from required_jobs required
    left join lateral (
      select run.run_id, run.source, run.status, run.started_at, run.finished_at, run.error
      from public.sbi_source_runs run
      where run.job = required.job
      order by coalesce(run.finished_at, run.started_at) desc nulls last, run.run_id desc
      limit 1
    ) latest on true
    left join lateral (
      select run.started_at, run.finished_at
      from public.sbi_source_runs run
      where run.job = required.job
        and run.status = 'completed'
      order by coalesce(run.finished_at, run.started_at) desc nulls last, run.run_id desc
      limit 1
    ) success on true
  ),
  refresh_summary as (
    select
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'job', per_job.job,
          'expectedMaxAgeHours', per_job.max_age_hours,
          'fresh', per_job.fresh,
          'stuckRuns', per_job.stuck_runs,
          'lastSuccessfulAt', per_job.last_successful_at,
          'latest', case
            when per_job.latest_run_id is null then null
            else pg_catalog.jsonb_build_object(
              'runId', per_job.latest_run_id,
              'source', per_job.latest_source,
              'status', per_job.latest_status,
              'startedAt', per_job.latest_started_at,
              'finishedAt', per_job.latest_finished_at,
              'hasError', per_job.latest_has_error
            )
          end
        ) order by per_job.display_order
      ) as jobs,
      coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(per_job.job) order by per_job.display_order)
          filter (where not per_job.fresh),
        '[]'::jsonb
      ) as stale_jobs,
      coalesce(pg_catalog.sum(per_job.stuck_runs), 0)::integer as stuck_runs,
      coalesce(pg_catalog.bool_and(per_job.fresh), false) as all_fresh
    from per_job
  ),
  integrity as (
    select public.buyer_intelligence_schema_check() as value
  )
  select pg_catalog.jsonb_build_object(
    'ok',
      coalesce((integrity.value ->> 'ok')::boolean, false)
      and coalesce((integrity.value ->> 'missingPropertyAddresses')::integer, -1) = 0
      and refresh_summary.all_fresh
      and refresh_summary.stuck_runs = 0,
    'revision', '202608190004_refresh_status',
    'serviceRoleOnly', true,
    'generatedAt', pg_catalog.now(),
    'integrity', integrity.value,
    'refresh', pg_catalog.jsonb_build_object(
      'allFresh', refresh_summary.all_fresh,
      'staleJobs', refresh_summary.stale_jobs,
      'stuckRuns', refresh_summary.stuck_runs,
      'jobs', refresh_summary.jobs
    )
  )
  from refresh_summary
  cross join integrity;
$function$;

revoke all on function public.buyer_intelligence_refresh_status() from public;
revoke execute on function public.buyer_intelligence_refresh_status() from anon, authenticated;
grant execute on function public.buyer_intelligence_refresh_status() to service_role;

comment on function public.buyer_intelligence_refresh_status() is
  'Service-role-only, read-only buyerDB freshness and Manhattan address-integrity status for Lucia.';
