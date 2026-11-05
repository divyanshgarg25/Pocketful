-- Pocketful Security Hardening & Data Integrity Migration
-- Migration: 004_security_hardening.sql
-- Addresses audit findings H1 (RLS & View Isolation) and H3 (Immutability & Constraints)

-- 1. Ensure approvals table has required columns before view creation
alter table if exists approvals add column if not exists money_out_minor integer not null default 0;
alter table if exists approvals add column if not exists challenge_nonce text;
alter table if exists approvals add column if not exists challenge_expires_at timestamptz;
alter table if exists approvals add column if not exists decision_idempotency_key text;
alter table if exists approvals add column if not exists decision_response jsonb;

-- Drop and recreate constraints on approvals
alter table approvals drop constraint if exists approvals_status_check;
alter table approvals add constraint approvals_status_check
  check (status in ('pending','approved','executing','executed','failed','denied','expired','cancelled'));

alter table approvals drop constraint if exists approvals_action_type_check;
alter table approvals add constraint approvals_action_type_check
  check (action_type in ('cancel_subscription','send_requests','refund_group','vault_move','pocket_move','reset_learning','delete_data','change_caps'));

-- Secure Guardian Weekly Money Out View
-- Recreate with security_invoker = true, current-week boundary filter, and restricted grants
drop view if exists weekly_money_out;
create or replace view weekly_money_out with (security_invoker = true) as
select
  user_id,
  date_trunc('week', executed_at at time zone 'UTC') as week,
  coalesce(sum(money_out_minor), 0) as total_minor
from approvals
where status = 'executed'
  and executed_at >= date_trunc('week', now() at time zone 'UTC')
group by 1, 2;

revoke all on weekly_money_out from public;
grant select on weekly_money_out to authenticated, service_role;

-- 2. Lockdown Internal Tables with RLS
-- Webhook Events, LLM Cache, Job Runs must NEVER be accessible to anon or untrusted users
alter table if exists webhook_events enable row level security;
alter table if exists llm_cache enable row level security;
alter table if exists job_runs enable row level security;

revoke all on webhook_events from public, anon;
revoke all on llm_cache from public, anon;
revoke all on job_runs from public, anon;

grant all on webhook_events to service_role;
grant all on llm_cache to service_role;
grant all on job_runs to service_role;

-- Webhook events constraint
alter table webhook_events drop constraint if exists webhook_events_status_check;
alter table webhook_events add constraint webhook_events_status_check
  check (status in ('processing','processed','failed','ignored'));

-- 3. Statement-Level Truncate Protection on Immutable/Audit Tables
create or replace function forbid_truncate() returns trigger language plpgsql as $$
begin
  raise exception 'TRUNCATE is strictly forbidden on table %', tg_table_name;
end;
$$;

drop trigger if exists audit_no_truncate on audit_log;
create trigger audit_no_truncate before truncate on audit_log
  for each statement execute function forbid_truncate();

drop trigger if exists approvals_no_truncate on approvals;
create trigger approvals_no_truncate before truncate on approvals
  for each statement execute function forbid_truncate();

-- 4. Approvals Transition-Guard Trigger
create or replace function enforce_approval_transition()
returns trigger language plpgsql as $$
declare
  terminal_statuses text[] := array['executed','denied','expired','cancelled'];
  allowed_transitions jsonb := '{
    "pending":    ["approved","denied","expired","cancelled"],
    "approved":   ["executing","denied","expired","cancelled"],
    "executing":  ["executed","failed"],
    "failed":     ["executing"]
  }'::jsonb;
  allowed_next text[];
begin
  if old.status = any(terminal_statuses) then
    raise exception 'Cannot transition approval % from terminal status %', old.id, old.status;
  end if;
  select array(select jsonb_array_elements_text(allowed_transitions -> old.status))
    into allowed_next;
  if new.status <> old.status and not (new.status = any(allowed_next)) then
    raise exception 'Invalid approval transition % -> % for id %', old.status, new.status, old.id;
  end if;
  return new;
end;
$$;

-- Backward compatibility alias
create or replace function guard_approval_transition()
returns trigger language plpgsql as $$
begin
  return enforce_approval_transition();
end;
$$;

drop trigger if exists approval_transition_guard on approvals;
drop trigger if exists trg_enforce_approval_transition on approvals;
create trigger approval_transition_guard
  before update on approvals
  for each row execute function enforce_approval_transition();

-- 5. Approval Events Audit Table
create table if not exists approval_events (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references approvals(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  actor text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_approval_events_approval on approval_events(approval_id, created_at desc);

alter table approval_events enable row level security;
revoke all on approval_events from public, anon;
grant select on approval_events to authenticated;
grant all on approval_events to service_role;

create policy "read_own_approval_events" on approval_events
  for select using (
    exists (
      select 1 from approvals where approvals.id = approval_events.approval_id and approvals.user_id = auth.uid()
    )
  );

create or replace function record_approval_transition_event() returns trigger language plpgsql as $$
begin
  if old.status is distinct from new.status then
    insert into approval_events (approval_id, from_status, to_status, actor, metadata)
    values (
      new.id,
      old.status,
      new.status,
      coalesce(auth.uid()::text, 'service_role'),
      jsonb_build_object(
        'idempotency_key', new.idempotency_key,
        'action_type', new.action_type,
        'amount_minor', new.amount_minor
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists approval_event_logger on approvals;
create trigger approval_event_logger after update on approvals
  for each row execute function record_approval_transition_event();

-- Immutability trigger on approval_events
create or replace function prevent_approval_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'approval_events rows are immutable';
end;
$$;

drop trigger if exists trg_approval_events_immutable on approval_events;
create trigger trg_approval_events_immutable
  before update or delete or truncate on approval_events
  for each statement execute function prevent_approval_event_mutation();

-- 6. Integrity & Invariant Constraints
-- Prevent duplicate contacts within the same outing group
create unique index if not exists uq_group_payments_group_contact on group_payments (group_id, contact);

-- Currency allowlist on profiles
alter table profiles drop constraint if exists chk_profiles_currency;
alter table profiles add constraint chk_profiles_currency
  check (currency in ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY', 'KRW', 'KWD'));

-- Non-negative balance constraints on vault and pockets
alter table vault drop constraint if exists chk_vault_non_negative;
alter table vault add constraint chk_vault_non_negative
  check (goal_balance_minor >= 0 and rollover_balance_minor >= 0);

alter table pockets drop constraint if exists chk_pockets_target_non_negative;
alter table pockets add constraint chk_pockets_target_non_negative
  check (target_minor is null or target_minor >= 0);

-- Allow GDPR anonymization update on audit_log while preventing all other mutations
create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.user_id is null and old.user_id is not null then
    return new;
  end if;
  raise exception 'audit_log is append-only: updates and deletes are forbidden';
end;
$$;

drop trigger if exists audit_append_only on audit_log;
create trigger audit_append_only before update or delete on audit_log
  for each row execute function forbid_mutation();

-- Prevent direct cap escalation trigger on profiles
create or replace function prevent_direct_cap_escalation()
returns trigger language plpgsql as $$
declare
  v_role text;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('role', true), ''), current_user);
  if (old.per_action_cap_minor <> new.per_action_cap_minor or
      old.weekly_cap_minor <> new.weekly_cap_minor) and
     v_role not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'Direct cap escalation is not permitted; use the Guardian approval flow';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_cap_escalation on profiles;
create trigger trg_prevent_cap_escalation
  before update on profiles
  for each row execute function prevent_direct_cap_escalation();

-- 7. Privacy: GDPR Right to be Forgotten Stored Procedure
create or replace function erase_user(target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('role', true), ''), current_user);
  if v_role not in ('service_role', 'postgres', 'supabase_admin') then
    if auth.uid() is null or auth.uid() <> target_user_id then
      raise exception 'Unauthorized to erase data for user %', target_user_id;
    end if;
  end if;

  -- Delete in dependency order
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
  update audit_log set details = jsonb_build_object('redacted', true), user_id = null
    where user_id = target_user_id;
  delete from approvals         where user_id = target_user_id;
  delete from preferences       where user_id = target_user_id;
  delete from profiles          where id = target_user_id;

  return true;
end;
$$;

revoke all on function erase_user(uuid) from public, anon, authenticated;
grant execute on function erase_user(uuid) to service_role;
