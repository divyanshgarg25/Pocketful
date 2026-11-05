-- 008: append-only settlement ledger. Idempotent (re-applied by the harness). 001-007 are never edited.
--
-- Every PayPal capture and every refund of a friend's share is recorded here, once, as an immutable row. group_payments.status
-- is mutable workflow state; THIS table is the record of money actually moved, so "what does the platform currently hold
-- for this outing" is always collected - refunded. Pocketful's own PayPal account receives the funds (see README 3.4);
-- nothing here is, or implies, a payout to the organizer or the venue.
--
-- No foreign keys to groups/group_payments on purpose: financial history must survive deletion of the outing or the user.
-- organizer_id is pseudonymous and is set to NULL when the account is erased; that is the ONLY update the trigger allows.

create table if not exists settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  payment_id uuid not null,
  organizer_id uuid references profiles(id) on delete set null,
  kind text not null check (kind in ('capture', 'refund')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency in ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY', 'KRW', 'KWD')),
  paypal_capture_id text not null,
  paypal_refund_id text,
  actor text not null check (actor in ('friend_capture', 'webhook', 'organizer', 'system')),
  created_at timestamptz not null default now(),
  -- one capture and at most one (full) refund per payment: recording is idempotent
  constraint uq_settlements_payment_kind unique (payment_id, kind),
  constraint chk_settlements_refund_id check ((kind = 'refund') = (paypal_refund_id is not null))
);
create index if not exists idx_settlements_group on settlements(group_id);

create or replace function settlements_immutable() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and new.organizer_id is null and old.organizer_id is not null
     and (to_jsonb(new) - 'organizer_id') = (to_jsonb(old) - 'organizer_id') then
    return new; -- ON DELETE SET NULL when the organizer's account is erased
  end if;
  raise exception 'settlements is append-only (% is not allowed)', tg_op using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_settlements_immutable on settlements;
create trigger trg_settlements_immutable before update or delete on settlements
  for each row execute function settlements_immutable();
drop trigger if exists trg_settlements_no_truncate on settlements;
create trigger trg_settlements_no_truncate before truncate on settlements
  for each statement execute function settlements_immutable();

alter table settlements enable row level security;
revoke all on settlements from public, anon, authenticated;
grant select, insert on settlements to service_role;
-- Default privileges may already have granted service_role ALL on new tables: take the rest away explicitly. The trigger
-- above is the backstop for the table owner/superuser; this removes the ability from the API's own database role.
revoke update, delete, truncate on settlements from service_role;
