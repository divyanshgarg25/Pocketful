-- 009: step-up hardening. Idempotent (re-applied by the harness). 001-008 are never edited.
--   * H1: enrollment cooldown anchor + user-visible security notifications
--   * H2: atomic attempt counting / lockout (one UPDATE ... RETURNING; no read-modify-write race)
-- Everything here is service-role only: RLS enabled with no policies and all grants revoked from client roles.

-- 1. H1: cooldown anchor ------------------------------------------------------------------------------------
-- When a factor was last enrolled, replaced, reset, or its last factor removed. The API compares it against
-- STEPUP_ENROLL_COOLDOWN_HOURS. NULL (factors that predate this migration) means "no cooldown running".
alter table step_up_credentials add column if not exists factor_changed_at timestamptz;

-- 2. H1: security_notifications -----------------------------------------------------------------------------
-- A user-visible record that a step-up factor was enrolled / replaced / removed. Holds no secrets, PINs or codes.
create table if not exists security_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  kind text not null check (kind in ('factor_enrolled', 'factor_replaced', 'factor_removed')),
  factor text not null check (factor in ('pin', 'totp', 'passkey')),
  message text not null check (char_length(message) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists idx_security_notifications_user_created on security_notifications (user_id, created_at desc);
alter table security_notifications enable row level security;
revoke all on security_notifications from public, anon, authenticated;
grant all on security_notifications to service_role;

-- 3. H2: atomic attempt registration ------------------------------------------------------------------------
-- Records ONE verification attempt and decides lockout in a single statement. Two concurrent wrong guesses can never
-- both read failed_attempts = 0: the row lock taken by UPDATE serialises them, and under READ COMMITTED the second
-- statement re-evaluates its WHERE clause against the committed result of the first.
--   already locked -> 'locked' (nothing is changed; a correct code cannot unlock an account, even if in flight)
--   success        -> counter reset, 'ok'
--   failure        -> counter + 1; reaching p_max_attempts resets it to 0 and locks for p_lock_minutes
--   no such row    -> 'none' (the caller fails closed)
-- Output columns are prefixed o_ so they cannot collide with the table's column names inside the function body.
create or replace function step_up_register_attempt(
  p_user_id uuid,
  p_success boolean,
  p_max_attempts int default 5,
  p_lock_minutes int default 15
)
returns table (o_outcome text, o_failed_attempts int, o_locked_until timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_failed int;
  v_locked timestamptz;
begin
  if p_success then
    update step_up_credentials c
       set failed_attempts = 0,
           locked_until = null,
           updated_at = now()
     where c.user_id = p_user_id
       and (c.locked_until is null or c.locked_until <= now())
    returning c.failed_attempts, c.locked_until into v_failed, v_locked;
    if found then
      return query select 'ok'::text, 0, null::timestamptz;
      return;
    end if;
  else
    update step_up_credentials c
       set failed_attempts = case when c.failed_attempts + 1 >= p_max_attempts then 0 else c.failed_attempts + 1 end,
           locked_until = case when c.failed_attempts + 1 >= p_max_attempts
                               then now() + make_interval(mins => p_lock_minutes)
                               else c.locked_until end,
           updated_at = now()
     where c.user_id = p_user_id
       and (c.locked_until is null or c.locked_until <= now())
    returning c.failed_attempts, c.locked_until into v_failed, v_locked;
    if found then
      if v_locked is not null and v_locked > now() then
        return query select 'locked'::text, 0, v_locked;   -- this very attempt tripped the lock
      else
        return query select 'bad'::text, v_failed, v_locked;
      end if;
      return;
    end if;
  end if;

  -- No row was updated: the account is locked (or has no credentials row at all).
  select c.locked_until into v_locked from step_up_credentials c where c.user_id = p_user_id;
  if found and v_locked is not null and v_locked > now() then
    return query select 'locked'::text, 0, v_locked;
  else
    return query select 'none'::text, 0, null::timestamptz;
  end if;
end;
$$;
revoke all on function step_up_register_attempt(uuid, boolean, int, int) from public, anon, authenticated;
grant execute on function step_up_register_attempt(uuid, boolean, int, int) to service_role;
