-- Pocketful Indexes, Append-Only Triggers, Views & Row Level Security
-- Migration: 003_indexes_triggers_rls.sql
-- Conforms strictly to Pocketful Backend and Database Schema Document Sections 6.2 & 6.3

-- 1. Performance Indexes
create index if not exists idx_transactions_user_time on transactions (user_id, occurred_at desc);
create index if not exists idx_transactions_user_match on transactions (user_id, match_type) where excluded = false;
create index if not exists idx_suggestions_user_plan on suggestions (user_id, plan_id);
create index if not exists idx_suggestions_user_outcome on suggestions (user_id, outcome, shown_at desc);
create index if not exists idx_learning_events_user on learning_events (user_id, created_at desc) where reverted = false;
create index if not exists idx_approvals_user_status on approvals (user_id, status, expires_at);
create index if not exists idx_group_payments_group on group_payments (group_id);
create index if not exists idx_audit_log_user on audit_log (user_id, created_at desc);
create index if not exists idx_venues_cache_coords on venues_cache (lat, lng);
create index if not exists idx_subscriptions_user_status on subscriptions (user_id, status);
create index if not exists idx_chat_messages_user on chat_messages (user_id, created_at desc);
create index if not exists idx_occasions_user_starts on occasions (user_id, starts_on);
create index if not exists idx_habits_user_status on habits (user_id, status);
create index if not exists idx_holidays_region_date on holidays (region, date);

-- 2. Append-Only Trigger on audit_log
create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only: updates and deletes are forbidden';
end;
$$;

drop trigger if exists audit_append_only on audit_log;
create trigger audit_append_only before update or delete on audit_log
  for each row execute function forbid_mutation();

-- 3. Guardian Weekly Money Out View
create or replace view weekly_money_out as
select
  user_id,
  date_trunc('week', executed_at) as week,
  sum(amount_minor) as total_minor
from approvals
where status = 'executed'
group by 1, 2;

-- 4. Enable Row Level Security (RLS) on all user-owned & reference tables
alter table profiles enable row level security;
alter table preferences enable row level security;
alter table subscriptions enable row level security;
alter table venues_cache enable row level security;
alter table place_queries enable row level security;
alter table plans enable row level security;
alter table suggestions enable row level security;
alter table transactions enable row level security;
alter table learning_events enable row level security;
alter table bandit_state enable row level security;
alter table groups enable row level security;
alter table group_payments enable row level security;
alter table mood_checkins enable row level security;
alter table vault enable row level security;
alter table approvals enable row level security;
alter table audit_log enable row level security;
alter table chat_messages enable row level security;
alter table holidays enable row level security;
alter table user_leave_days enable row level security;
alter table habits enable row level security;
alter table occasions enable row level security;
alter table pockets enable row level security;
alter table getaway_destinations enable row level security;
alter table nudge_settings enable row level security;

-- 5. RLS Policies
-- Profiles: owner can select and update
create policy "own_profile" on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- Preferences: owner can select and update
create policy "own_preferences" on preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Subscriptions: owner can read; writes via API service role
create policy "read_own_subscriptions" on subscriptions
  for select using (user_id = auth.uid());

-- Transactions: owner can read; writes via API service role
create policy "read_own_transactions" on transactions
  for select using (user_id = auth.uid());

-- Plans & Suggestions: owner can read
create policy "read_own_plans" on plans
  for select using (user_id = auth.uid());

create policy "read_own_suggestions" on suggestions
  for select using (user_id = auth.uid());

-- Learning & Bandit: owner can read; updates restricted to server
create policy "read_own_learning" on learning_events
  for select using (user_id = auth.uid());

create policy "read_own_bandit" on bandit_state
  for select using (user_id = auth.uid());

-- Groups & Payments: organizer reads; friend page reads by token via server
create policy "read_own_groups" on groups
  for select using (organizer_id = auth.uid());

-- Approvals: owner can read
create policy "read_own_approvals" on approvals
  for select using (user_id = auth.uid());

-- Audit Log: strictly readable by owner; inserts by server only
create policy "read_own_audit" on audit_log
  for select using (user_id = auth.uid());

-- Chat Messages: owner can read
create policy "read_own_chat" on chat_messages
  for select using (user_id = auth.uid());

-- Mood, Vault & Pockets
create policy "own_mood" on mood_checkins
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "read_own_vault" on vault
  for select using (user_id = auth.uid());

create policy "read_own_pockets" on pockets
  for select using (user_id = auth.uid());

-- Habits, Occasions & Nudges
create policy "read_own_habits" on habits
  for select using (user_id = auth.uid());

create policy "read_own_occasions" on occasions
  for select using (user_id = auth.uid());

create policy "own_leave_days" on user_leave_days
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own_nudge_settings" on nudge_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Reference Data: authenticated users can read cached venues, holidays & getaways
create policy "read_venues" on venues_cache
  for select using (auth.role() = 'authenticated');

create policy "read_place_queries" on place_queries
  for select using (auth.role() = 'authenticated');

create policy "read_holidays" on holidays
  for select using (auth.role() = 'authenticated');

create policy "read_getaways" on getaway_destinations
  for select using (auth.role() = 'authenticated');
