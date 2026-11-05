-- 005_audit_fixes.sql — re-audit fixes. Every statement is idempotent (safe to re-run).
-- Sections are appended per phase; do not edit 001-004.

-- =====================================================================================
-- A. Helpers
-- =====================================================================================

-- True when the erasure flag is on AND the caller is not a client-facing role.
-- (Defence in depth: an `authenticated` session cannot unlock immutability by set_config.)
create or replace function pocketful_erasure_active() returns boolean
language sql stable as $$
  select coalesce(current_setting('pocketful.erasure', true), '') = 'on'
     and current_user not in ('anon', 'authenticated')
$$;

-- =====================================================================================
-- A2. erase_user(): immutability triggers + tombstone
-- =====================================================================================

create table if not exists erased_users (
  user_id uuid primary key,
  erased_at timestamptz not null default now()
);
alter table erased_users add column if not exists auth_deleted_at timestamptz;
alter table erased_users enable row level security;
revoke all on erased_users from public, anon, authenticated;
grant all on erased_users to service_role;

-- approval_events: row-level for UPDATE/DELETE (only under the erasure flag), statement-level TRUNCATE (never).
create or replace function prevent_approval_event_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'approval_events rows are immutable (TRUNCATE forbidden)';
  end if;
  if pocketful_erasure_active() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'approval_events rows are immutable';
end;
$$;

drop trigger if exists trg_approval_events_immutable on approval_events;
drop trigger if exists trg_approval_events_immutable_row on approval_events;
drop trigger if exists trg_approval_events_no_truncate on approval_events;
create trigger trg_approval_events_immutable_row
  before update or delete on approval_events
  for each row execute function prevent_approval_event_mutation();
create trigger trg_approval_events_no_truncate
  before truncate on approval_events
  for each statement execute function prevent_approval_event_mutation();

-- audit_log: UPDATE/DELETE always raise, except the single anonymising UPDATE under the erasure flag.
-- Closes the old loophole where any UPDATE that nulled user_id could rewrite other columns.
create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and pocketful_erasure_active()
     and old.user_id is not null and new.user_id is null
     and new.params = '{"redacted": true}'::jsonb
     and new.result = '{"redacted": true}'::jsonb
     and (new.id, new.request_id, new.agent, new.action, new.approval_id, new.created_at)
         is not distinct from
         (old.id, old.request_id, old.agent, old.action, old.approval_id, old.created_at)
  then
    return new;
  end if;
  raise exception 'audit_log is append-only: updates and deletes are forbidden';
end;
$$;
drop trigger if exists audit_append_only on audit_log;
create trigger audit_append_only before update or delete on audit_log
  for each row execute function forbid_mutation();

create or replace function erase_user(target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_pat text := '%' || target_user_id::text || '%';
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''),
    nullif(current_setting('role', true), 'none'),
    session_user
  );
  if v_role not in ('service_role', 'postgres', 'supabase_admin') then
    if auth.uid() is null or auth.uid() <> target_user_id then
      raise exception 'Unauthorized to erase data for user %', target_user_id;
    end if;
  end if;

  perform set_config('pocketful.erasure', 'on', true);

  -- Third-party webhook payloads that reference this user's payments/groups (payer PII) go first.
  delete from webhook_events where payload::text like v_pat
    or exists (
      select 1 from group_payments gp join groups g on g.id = gp.group_id
      where g.organizer_id = target_user_id
        and (webhook_events.payload::text like '%' || gp.id::text || '%' or webhook_events.payload::text like '%' || g.id::text || '%')
    );
  delete from job_runs where job like v_pat or lease_key like v_pat;

  delete from user_leave_days   where user_id = target_user_id;
  delete from occasions         where user_id = target_user_id;
  delete from habits            where user_id = target_user_id;
  delete from nudge_settings    where user_id = target_user_id;
  delete from pockets           where user_id = target_user_id;
  delete from chat_messages     where user_id = target_user_id;
  delete from mood_checkins     where user_id = target_user_id;
  delete from vault             where user_id = target_user_id;
  delete from group_payments    where group_id in (select id from groups where organizer_id = target_user_id);
  delete from groups            where organizer_id = target_user_id;
  delete from transactions      where user_id = target_user_id;
  delete from learning_events   where user_id = target_user_id;
  delete from bandit_state      where user_id = target_user_id;
  delete from suggestions       where user_id = target_user_id;
  delete from plans             where user_id = target_user_id;
  delete from subscriptions     where user_id = target_user_id;
  delete from approval_events   where approval_id in (select id from approvals where user_id = target_user_id);

  update audit_log
     set params = jsonb_build_object('redacted', true),
         result = jsonb_build_object('redacted', true),
         user_id = null
   where user_id = target_user_id;

  delete from approvals         where user_id = target_user_id;
  delete from preferences       where user_id = target_user_id;
  delete from profiles          where id = target_user_id;

  insert into erased_users (user_id) values (target_user_id) on conflict (user_id) do nothing;
  return true;
end;
$$;
revoke all on function erase_user(uuid) from public, anon, authenticated;
grant execute on function erase_user(uuid) to service_role;

-- =====================================================================================
-- A3. job_runs: period_key + atomic leases
-- =====================================================================================
alter table job_runs add column if not exists period_key text;
alter table job_runs add column if not exists lease_key text;
alter table job_runs add column if not exists lease_expires_at timestamptz;

create unique index if not exists uq_job_runs_active
  on job_runs (lease_key) where status = 'running';
create unique index if not exists uq_job_runs_period
  on job_runs (job, period_key) where period_key is not null and status in ('running', 'ok');

-- =====================================================================================
-- A4. Schema drift
-- =====================================================================================
alter table group_payments add column if not exists viewed_at timestamptz;
alter table approvals add column if not exists created_at timestamptz not null default now();

-- webhook_events default status violated the 004 CHECK ('received' is not allowed there).
alter table webhook_events alter column status set default 'processing';

-- BACKFILL-BEGIN
-- Executed vault/pocket moves recorded money_out_minor = 0 before 004; they are money-out.
-- The transition guard rejects every UPDATE of a terminal row, so it is paused for this statement only.
begin;
alter table approvals disable trigger approval_transition_guard;
update approvals set money_out_minor = amount_minor
  where action_type in ('vault_move', 'pocket_move') and money_out_minor = 0 and status = 'executed' and amount_minor > 0;
alter table approvals enable trigger approval_transition_guard;
commit;
-- BACKFILL-END

-- =====================================================================================
-- A5. Weekly money-out in the user's timezone (replaces the UTC-week view)
-- =====================================================================================
create or replace function weekly_money_out_for(p_user uuid, p_tz text, p_now timestamptz default now())
returns bigint
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_start timestamptz;
begin
  -- Evaluated eagerly (not in a CTE the planner may skip): an invalid p_tz raises, it never falls back to UTC.
  v_start := date_trunc('week', p_now at time zone p_tz) at time zone p_tz;
  return coalesce((
    select sum(a.money_out_minor)
      from approvals a
     where a.user_id = p_user
       and a.status = 'executed'
       and a.executed_at >= v_start
       and a.executed_at <  v_start + interval '7 days'
  ), 0)::bigint;
end;
$$;
revoke all on function weekly_money_out_for(uuid, text, timestamptz) from public, anon;
grant execute on function weekly_money_out_for(uuid, text, timestamptz) to authenticated, service_role;
drop view if exists weekly_money_out;

-- =====================================================================================
-- A6. Currency allowlist on every money-moving currency column
-- =====================================================================================
alter table groups drop constraint if exists chk_groups_currency;
alter table groups add constraint chk_groups_currency
  check (currency in ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY', 'KRW', 'KWD'));

-- =====================================================================================
-- B3. Atomic execute-time cap enforcement
-- =====================================================================================
-- Takes a per-user advisory lock, sums the user's executing + executed money-out for the current local week,
-- rejects if this approval would exceed the CURRENT caps, and otherwise moves approved|failed -> executing.
-- SQLSTATEs: P0002 not found, P0003 conflict (wrong status), P0004 expired, P0005 guardian blocked.
create or replace function begin_execution(p_approval uuid, p_user uuid, p_tz text, p_now timestamptz default now())
returns approvals
language plpgsql
security invoker
set search_path = public
as $$
declare
  a approvals;
  prof profiles;
  v_start timestamptz;
  v_used bigint;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select * into a from approvals where id = p_approval and user_id = p_user for update;
  if not found then raise exception 'approval not found' using errcode = 'P0002'; end if;
  if a.status not in ('approved', 'failed') then
    raise exception 'approval status is %', a.status using errcode = 'P0003';
  end if;
  if a.status = 'approved' and a.expires_at <= p_now then
    raise exception 'approval expired' using errcode = 'P0004';
  end if;

  select * into prof from profiles where id = p_user;
  if not found then raise exception 'profile not found' using errcode = 'P0002'; end if;

  if a.money_out_minor > 0 then
    if prof.per_action_cap_minor = 0 or prof.weekly_cap_minor = 0 then
      raise exception 'spending caps are zero' using errcode = 'P0005';
    end if;
    if a.money_out_minor > prof.per_action_cap_minor then
      raise exception 'exceeds per-action cap' using errcode = 'P0005';
    end if;
    v_start := date_trunc('week', p_now at time zone p_tz) at time zone p_tz;
    select coalesce(sum(x.money_out_minor), 0) into v_used
      from approvals x
     where x.user_id = p_user
       and x.id <> a.id
       and x.status in ('executing', 'executed')
       and coalesce(x.executed_at, x.decided_at, x.created_at) >= v_start
       and coalesce(x.executed_at, x.decided_at, x.created_at) < v_start + interval '7 days';
    if v_used + a.money_out_minor > prof.weekly_cap_minor then
      raise exception 'exceeds weekly cap' using errcode = 'P0005';
    end if;
  end if;

  update approvals set status = 'executing' where id = a.id returning * into a;
  return a;
end;
$$;
revoke all on function begin_execution(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function begin_execution(uuid, uuid, text, timestamptz) to service_role;

-- B2. Retry attempts are capped (3) by the API; the counter lives on the approval.
alter table approvals add column if not exists retry_count integer not null default 0;
