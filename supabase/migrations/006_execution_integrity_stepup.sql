-- 006: execute-time cap enforcement, execution outcome tracking, step-up credentials.
-- Idempotent. Independent of any 005 (apply after it if present).

-- 1. Execution outcome / retry tracking -------------------------------------
alter table approvals add column if not exists execution_outcome jsonb;
alter table approvals add column if not exists retry_count integer not null default 0;
alter table approvals add column if not exists challenge_fingerprint text;

-- 2. Step-up credentials (PIN). Service role only; never exposed via RLS. ----
create table if not exists step_up_credentials (
  user_id uuid primary key references profiles(id) on delete cascade,
  pin_salt text not null,
  pin_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  enrolled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table step_up_credentials enable row level security;
revoke all on step_up_credentials from public, anon, authenticated;
grant all on step_up_credentials to service_role;

-- 3. Atomic begin_execution -------------------------------------------------
-- Checks caps against CURRENT profile values and everything already executing or
-- executed this week (in the user's timezone), under a per-user advisory lock,
-- then performs the status transition in the same transaction.
drop function if exists begin_execution(uuid, uuid, text, timestamptz);
create or replace function begin_execution(
  p_approval uuid,
  p_user uuid,
  p_tz text default 'UTC',
  p_from text[] default array['approved']
) returns jsonb
language plpgsql
as $$
declare
  a approvals%rowtype;
  prof profiles%rowtype;
  week_start timestamptz;
  used bigint;
  mo bigint;
begin
  -- Fail loudly on an invalid timezone instead of silently using UTC.
  week_start := date_trunc('week', (now() at time zone p_tz)) at time zone p_tz;

  perform pg_advisory_xact_lock(hashtext('begin_execution:' || p_user::text));

  select * into a from approvals where id = p_approval and user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if not (a.status = any(p_from)) then
    return jsonb_build_object('ok', false, 'code', 'BAD_STATUS', 'status', a.status);
  end if;
  if a.status = 'approved' and a.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'EXPIRED');
  end if;
  if a.execution_outcome is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_EXECUTED_SIDE_EFFECT');
  end if;

  select * into prof from profiles where id = p_user;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  mo := coalesce(a.money_out_minor, 0);
  if mo > 0 then
    if prof.per_action_cap_minor = 0 or prof.weekly_cap_minor = 0 then
      return jsonb_build_object('ok', false, 'code', 'CAP_ZERO',
        'reason', 'Spending safety cap is set to zero (spending is locked).');
    end if;
    if prof.per_action_cap_minor > 0 and mo > prof.per_action_cap_minor then
      return jsonb_build_object('ok', false, 'code', 'PER_ACTION_CAP',
        'reason', 'Amount exceeds your per-action safety cap.');
    end if;
    select coalesce(sum(money_out_minor), 0) into used
      from approvals
     where user_id = p_user
       and id <> p_approval
       and status in ('executing', 'executed')
       and coalesce(executed_at, decided_at, now()) >= week_start;
    if prof.weekly_cap_minor > 0 and used + mo > prof.weekly_cap_minor then
      return jsonb_build_object('ok', false, 'code', 'WEEKLY_CAP',
        'reason', 'This action would exceed your weekly safety cap.',
        'used_minor', used, 'money_out_minor', mo, 'cap_minor', prof.weekly_cap_minor);
    end if;
  end if;

  update approvals
     set status = 'executing',
         retry_count = case when a.status = 'failed' then retry_count + 1 else retry_count end
   where id = p_approval;

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function begin_execution(uuid, uuid, text, text[]) from public, anon, authenticated;
grant execute on function begin_execution(uuid, uuid, text, text[]) to service_role;

-- 4. Payment capture claim: 'capturing' prevents two requests from calling PayPal for the same order.
alter table group_payments add column if not exists capture_started_at timestamptz;
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'group_payments_status_check' and conrelid = 'group_payments'::regclass) then
    alter table group_payments drop constraint group_payments_status_check;
  end if;
  alter table group_payments add constraint group_payments_status_check
    check (status in ('draft','sent','viewed','capturing','paid','failed','refunded','cancelled'));
end $$;

-- 5. New approval action type: change_currency (currency changes rescale caps, so they need approval).
alter table approvals drop constraint if exists approvals_action_type_check;
alter table approvals add constraint approvals_action_type_check
  check (action_type in ('cancel_subscription','send_requests','refund_group','vault_move','pocket_move','reset_learning','delete_data','change_caps','change_currency'));

-- 6. Atomic pocket / vault moves: debit and credit are ONE transaction; money can never vanish.
create or replace function move_weekly_to_vault(p_user uuid, p_action text, p_amount bigint)
returns jsonb language plpgsql as $$
declare bal bigint; v vault%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'BAD_AMOUNT');
  end if;
  if p_action not in ('lock_in', 'roll_over') then
    return jsonb_build_object('ok', false, 'code', 'BAD_ACTION');
  end if;
  select balance_minor into bal from pockets where user_id = p_user and kind = 'weekly' for update;
  if not found or bal < p_amount then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT', 'balance_minor', coalesce(bal, 0));
  end if;
  update pockets set balance_minor = balance_minor - p_amount where user_id = p_user and kind = 'weekly';
  insert into vault (user_id, goal_balance_minor, rollover_balance_minor)
  values (p_user,
          case when p_action = 'lock_in' then p_amount else 0 end,
          case when p_action = 'roll_over' then p_amount else 0 end)
  on conflict (user_id) do update
    set goal_balance_minor = vault.goal_balance_minor + excluded.goal_balance_minor,
        rollover_balance_minor = vault.rollover_balance_minor + excluded.rollover_balance_minor
  returning * into v;
  return jsonb_build_object('ok', true, 'vault', to_jsonb(v));
end;
$$;

create or replace function move_pocket_balance(p_user uuid, p_from text, p_to text, p_amount bigint)
returns jsonb language plpgsql as $$
declare src pockets%rowtype;
begin
  if p_amount is null or p_amount <= 0 or p_from = p_to then
    return jsonb_build_object('ok', false, 'code', 'BAD_ARGS');
  end if;
  -- lock both rows in a fixed order to avoid deadlocks between opposite moves
  perform 1 from pockets where user_id = p_user and kind in (p_from, p_to) order by kind for update;
  select * into src from pockets where user_id = p_user and kind = p_from;
  if not found or src.balance_minor < p_amount then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT', 'balance_minor', coalesce(src.balance_minor, 0));
  end if;
  update pockets set balance_minor = balance_minor - p_amount where user_id = p_user and kind = p_from;
  insert into pockets (user_id, kind, balance_minor, is_simulated)
  values (p_user, p_to, p_amount, src.is_simulated)
  on conflict (user_id, kind) do update set balance_minor = pockets.balance_minor + excluded.balance_minor;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function move_weekly_to_vault(uuid, text, bigint) from public, anon, authenticated;
revoke all on function move_pocket_balance(uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function move_weekly_to_vault(uuid, text, bigint) to service_role;
grant execute on function move_pocket_balance(uuid, text, text, bigint) to service_role;
