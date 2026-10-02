-- Mock reputation passport metrics.
-- Sandbox ledger only: these columns are not an on-chain write and do not
-- move funds. reputation_totals is one passport per agent. reputation_events
-- is one job outcome (success or failure, including SLA timeout and
-- validation failure). Typed columns are the source of truth. body stays a
-- copy of the in-memory record so a row written before this migration still
-- loads. Existing select policies and the service-role grants cover the new
-- columns. RLS stays enabled.

alter table public.reputation_totals
  add column event_count integer not null default 0,
  add column success_count integer not null default 0,
  add column failure_count integer not null default 0,
  add column error_count integer not null default 0,
  add column hallucination_count integer not null default 0,
  add column latency_total_ms bigint not null default 0,
  add column volume_settled_usdc text not null default '0.000000',
  add column success_rate text not null default '0.000000',
  add column avg_latency_ms text not null default '0.000',
  add column error_index text not null default '0.000000',
  add column score text not null default '0.0000',
  add column updated_at text,
  add constraint reputation_totals_counts_check check (
    event_count >= 0
    and success_count >= 0
    and failure_count >= 0
    and error_count >= 0
    and hallucination_count >= 0
    and latency_total_ms >= 0
    and success_count + failure_count = event_count
    and error_count <= event_count
    and hallucination_count <= event_count
  );

alter table public.reputation_events
  add column outcome text not null default 'failure',
  add column latency_ms integer not null default 0,
  add column volume_usdc text not null default '0.000000',
  add column is_error boolean not null default false,
  add column hallucination boolean not null default false,
  add column source_ref text,
  add column created_at text not null default '',
  add constraint reputation_events_outcome_check check (outcome in ('success', 'failure')),
  add constraint reputation_events_latency_check check (latency_ms >= 0 and latency_ms <= 86400000);

create index reputation_events_agent_outcome_idx
  on public.reputation_events (agent_id, outcome);

comment on table public.reputation_totals is
  'Mock reputation passport per agent. Volume, success rate, latency, error index, and score. Not an on-chain record.';

comment on table public.reputation_events is
  'Mock job outcomes that feed a reputation passport. success, validation failure, and SLA timeout.';

comment on column public.reputation_totals.success_rate is
  'Floored successCount / eventCount, six decimal places. 0.000000 when there are no events.';

comment on column public.reputation_totals.avg_latency_ms is
  'Floored mean latency in milliseconds, three decimal places.';

comment on column public.reputation_totals.error_index is
  'Floored min(1, (errorCount + hallucinationCount) / eventCount), six decimal places.';

comment on column public.reputation_totals.score is
  'roster.passport.v1 score from 0.0000 to 100.0000.';

comment on column public.reputation_totals.volume_settled_usdc is
  'USDC settled on success only, six decimal places.';

comment on column public.reputation_events.outcome is
  'Job outcome recorded on the passport: success or failure.';

comment on column public.reputation_events.is_error is
  'True when the job failed validation or timed out.';

-- One-shot backfill from body. Integer division matches roster.passport.v1.
-- Helpers are dropped at the end of this migration.

create or replace function private.roster_format_fixed(units bigint, places integer)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  scale bigint := power(10, places)::bigint;
begin
  return (units / scale)::text || '.' || lpad((units % scale)::text, places, '0');
end;
$$;

create or replace function private.roster_usdc_micros(amount text)
returns bigint
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  trimmed text := btrim(coalesce(amount, ''));
  whole text;
  frac text;
begin
  if trimmed !~ '^[0-9]+(\.[0-9]+)?$' then
    return 0;
  end if;
  whole := split_part(trimmed, '.', 1);
  frac := left(rpad(split_part(trimmed, '.', 2), 6, '0'), 6);
  return whole::bigint * 1000000 + frac::bigint;
end;
$$;

create or replace function private.roster_passport_projection(
  p_event_count integer,
  p_success_count integer,
  p_error_count integer,
  p_hallucination_count integer,
  p_latency_total_ms bigint,
  p_volume_settled_usdc text,
  out success_rate text,
  out avg_latency_ms text,
  out error_index text,
  out score text
)
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  micro constant bigint := 1000000;
  reference constant bigint := 1000000000;
  counted bigint := p_event_count;
  success_micros bigint := 0;
  latency_micros bigint := 0;
  error_micros bigint := 0;
  reliability_micros bigint := 0;
  volume_micros bigint := 0;
  budget bigint;
  error_raw bigint;
  volume bigint;
  weighted bigint;
  score_units bigint;
  thousandths bigint;
begin
  if counted = 0 then
    success_rate := private.roster_format_fixed(0, 6);
    avg_latency_ms := private.roster_format_fixed(0, 3);
    error_index := private.roster_format_fixed(0, 6);
    score := private.roster_format_fixed(0, 4);
    return;
  end if;
  success_micros := (p_success_count::bigint * micro) / counted;
  budget := 2000 * counted;
  if p_latency_total_ms >= budget then
    latency_micros := 0;
  else
    latency_micros := ((budget - p_latency_total_ms) * micro) / budget;
  end if;
  error_raw := ((p_error_count + p_hallucination_count)::bigint * micro) / counted;
  error_micros := case when error_raw > micro then micro else error_raw end;
  reliability_micros := micro - error_micros;
  volume := private.roster_usdc_micros(p_volume_settled_usdc);
  if volume >= reference then
    volume_micros := micro;
  else
    volume_micros := (volume * micro) / reference;
  end if;
  weighted := success_micros * 45 + latency_micros * 25 + reliability_micros * 20 + volume_micros * 10;
  score_units := weighted / 100;
  thousandths := (p_latency_total_ms * 1000) / counted;
  success_rate := private.roster_format_fixed(success_micros, 6);
  avg_latency_ms := private.roster_format_fixed(thousandths, 3);
  error_index := private.roster_format_fixed(error_micros, 6);
  score := private.roster_format_fixed(score_units, 4);
end;
$$;

revoke all on function private.roster_format_fixed(bigint, integer) from public, anon, authenticated;
revoke all on function private.roster_usdc_micros(text) from public, anon, authenticated;
revoke all on function private.roster_passport_projection(integer, integer, integer, integer, bigint, text) from public, anon, authenticated;

update public.reputation_totals as totals
set
  event_count = parsed.event_count,
  success_count = parsed.success_count,
  failure_count = parsed.failure_count,
  error_count = parsed.error_count,
  hallucination_count = parsed.hallucination_count,
  latency_total_ms = parsed.latency_total_ms,
  volume_settled_usdc = parsed.volume_settled_usdc,
  success_rate = proj.success_rate,
  avg_latency_ms = proj.avg_latency_ms,
  error_index = proj.error_index,
  score = proj.score,
  updated_at = parsed.updated_at
from (
  select
    agent_id,
    coalesce((body->>'eventCount')::integer, 0) as event_count,
    coalesce((body->>'successCount')::integer, 0) as success_count,
    coalesce((body->>'failureCount')::integer, 0) as failure_count,
    coalesce((body->>'errorCount')::integer, 0) as error_count,
    coalesce((body->>'hallucinationCount')::integer, 0) as hallucination_count,
    coalesce((body->>'latencyTotalMs')::bigint, 0) as latency_total_ms,
    coalesce(body->>'volumeSettledUsdc', '0.000000') as volume_settled_usdc,
    nullif(body->>'updatedAt', '') as updated_at
  from public.reputation_totals
) as parsed
cross join lateral private.roster_passport_projection(
  parsed.event_count,
  parsed.success_count,
  parsed.error_count,
  parsed.hallucination_count,
  parsed.latency_total_ms,
  parsed.volume_settled_usdc
) as proj
where totals.agent_id = parsed.agent_id;

update public.reputation_events
set
  outcome = case
    when body->>'outcome' in ('success', 'failure') then body->>'outcome'
    else 'failure'
  end,
  latency_ms = least(coalesce((body->>'latencyMs')::integer, 0), 86400000),
  volume_usdc = coalesce(body->>'volumeUsdc', '0.000000'),
  is_error = coalesce((body->>'error')::boolean, false),
  hallucination = coalesce((body->>'hallucination')::boolean, false),
  source_ref = nullif(body->>'sourceRef', ''),
  created_at = coalesce(nullif(body->>'createdAt', ''), created_at);

drop function private.roster_passport_projection(integer, integer, integer, integer, bigint, text);
drop function private.roster_usdc_micros(text);
drop function private.roster_format_fixed(bigint, integer);
