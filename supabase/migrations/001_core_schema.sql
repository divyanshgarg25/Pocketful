-- Pocketful Core Database Schema Migration
-- Migration: 001_core_schema.sql
-- Conforms strictly to Pocketful Backend and Database Schema Document Section 6.1

create extension if not exists pgcrypto;

-- Profiles: Master user ledger profiles
create table if not exists profiles (
  id uuid primary key,
  name text not null,
  timezone text not null default 'UTC',
  home_lat double precision,
  home_lng double precision,
  home_label text,
  max_distance_km numeric(4,1) not null default 5.0 check (max_distance_km between 1.0 and 50.0),
  guilt_free_cap_minor bigint not null default 0 check (guilt_free_cap_minor >= 0),
  per_action_cap_minor bigint not null default 0 check (per_action_cap_minor >= 0),
  weekly_cap_minor bigint not null default 0 check (weekly_cap_minor >= 0),
  currency char(3) not null default 'USD',
  opt_in_mood boolean not null default false,
  opt_in_tracking boolean not null default false,
  exploration_level text not null default 'normal' check (exploration_level in ('off', 'low', 'normal')),
  created_at timestamptz not null default now()
);

-- Preferences: Vibe form & user leisure tastes
create table if not exists preferences (
  user_id uuid primary key references profiles(id) on delete cascade,
  interests text[] not null default '{}',
  social_pref text check (social_pref in ('solo', 'social', 'mixed')),
  vibe_pref text check (vibe_pref in ('quiet', 'lively', 'mixed'))
);

-- Subscriptions: Recurring payments & ghost subscription detection
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  merchant text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  interval text not null check (interval in ('weekly', 'monthly', 'yearly')),
  paypal_subscription_id text unique,
  status text not null default 'active' check (status in ('active', 'cancel_pending', 'cancelled')),
  last_used_signal timestamptz,
  flagged_ghost boolean not null default false,
  ghost_reason text,
  ghost_snoozed_until timestamptz,
  created_at timestamptz not null default now()
);

-- Venues Cache: OpenStreetMap & Overpass fetched venues with estimates
create table if not exists venues_cache (
  id uuid primary key default gen_random_uuid(),
  osm_id text unique,
  name text not null,
  category text not null,
  lat double precision not null,
  lng double precision not null,
  tags jsonb not null default '{}'::jsonb,
  est_cost_low_minor bigint,
  est_cost_high_minor bigint,
  currency char(3),
  cost_source text check (cost_source in ('estimate', 'price_level')),
  cost_confidence text check (cost_confidence in ('low', 'medium', 'high')),
  quietness text check (quietness in ('quiet', 'mixed', 'lively', 'unknown')) default 'unknown',
  fetched_at timestamptz not null default now(),
  cost_estimated_at timestamptz
);

-- Place Queries: Query key mapping to cached venues (7-day TTL)
create table if not exists place_queries (
  query_key text primary key,
  venue_ids uuid[] not null,
  fetched_at timestamptz not null default now()
);

-- Plans: Generated weekend plans
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  week text not null,
  mood text check (mood in ('drained', 'okay', 'great')),
  group_size int not null default 1 check (group_size between 1 and 20),
  budget_minor bigint not null,
  radius_km numeric(4,1) not null,
  status text not null default 'open' check (status in ('open', 'accepted', 'closed')),
  created_at timestamptz not null default now()
);

-- Suggestions: Three-slot suggestions per plan (Comfort, Stretch, New)
create table if not exists suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  plan_id uuid not null references plans(id) on delete cascade,
  venue_id uuid not null references venues_cache(id),
  slot text not null check (slot in ('comfort', 'stretch', 'new')),
  features jsonb not null,
  headline text,
  why text,
  reason_tags text[] not null default '{}',
  shown_at timestamptz not null default now(),
  outcome text check (outcome in ('accepted', 'modified', 'rejected', 'ignored')),
  reject_reason text check (reject_reason in ('too_far', 'too_pricey', 'not_my_vibe', 'did_recently')),
  decided_at timestamptz
);

-- Transactions: Ingested payments (PayPal sandbox, seeded, manual)
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  source text not null check (source in ('paypal_sandbox', 'seeded', 'manual')),
  source_ref text not null,
  occurred_at timestamptz not null,
  amount_minor bigint not null,
  currency char(3) not null,
  merchant_raw text not null,
  merchant_norm text not null,
  kind text check (kind in ('essential', 'leisure', 'subscription')),
  category text,
  venue_id uuid references venues_cache(id),
  linked_suggestion_id uuid references suggestions(id),
  match_type text check (match_type in ('followed', 'organic', 'ignored')),
  confidence real check (confidence between 0 and 1),
  needs_question boolean not null default false,
  user_rating text check (user_rating in ('worth_it', 'okay', 'too_much')),
  excluded boolean not null default false,
  unique (user_id, source_ref)
);

-- Learning Events: Append-only source of truth for preference learning
create table if not exists learning_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  event_type text not null,
  weight real not null,
  features jsonb not null,
  confidence real not null default 1,
  source_table text,
  source_id uuid,
  reverted boolean not null default false,
  created_at timestamptz not null default now()
);

-- Bandit State: Projection of learning_events for Thompson Sampling
create table if not exists bandit_state (
  user_id uuid not null references profiles(id) on delete cascade,
  feature text not null,
  value text not null,
  alpha real not null default 1 check (alpha >= 1),
  beta real not null default 1 check (beta >= 1),
  updated_at timestamptz not null default now(),
  primary key (user_id, feature, value)
);

-- Groups: Bill-splitting groups for outings
create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references profiles(id) on delete cascade,
  suggestion_id uuid references suggestions(id),
  transaction_id uuid references transactions(id),
  total_minor bigint not null check (total_minor > 0),
  currency char(3) not null,
  deadline timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'pending', 'confirmed', 'refunding', 'refunded', 'cancelled')),
  created_at timestamptz not null default now()
);

-- Group Payments: Individual payment allocations per friend
create table if not exists group_payments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  friend_name text not null,
  contact text not null,
  share_minor bigint not null check (share_minor > 0),
  public_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  paypal_ref text unique,
  pay_url text,
  capture_id text,
  refund_ref text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'viewed', 'paid', 'failed', 'refunded', 'cancelled')),
  paid_at timestamptz,
  last_nudged_at timestamptz
);

-- Mood Checkins: Weekly 3-stamp checkins (drained, okay, great)
create table if not exists mood_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  week text not null,
  level text not null check (level in ('drained', 'okay', 'great')),
  unique (user_id, week)
);

-- Vault: Leftover weekend savings holding area
create table if not exists vault (
  user_id uuid primary key references profiles(id) on delete cascade,
  goal_balance_minor bigint not null default 0,
  rollover_balance_minor bigint not null default 0,
  is_simulated boolean not null default true
);

-- Approvals: Guardian security and approval records for all money actions
create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  action_type text not null check (action_type in (
    'cancel_subscription', 'send_requests', 'refund_group', 'vault_move', 'reset_learning', 'delete_data', 'pocket_move'
  )),
  payload jsonb not null,
  preview text not null,
  amount_minor bigint not null default 0,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired', 'executed', 'failed')),
  idempotency_key text not null,
  result jsonb,
  expires_at timestamptz not null,
  decided_at timestamptz,
  executed_at timestamptz,
  unique (user_id, idempotency_key)
);

-- Audit Log: Strictly append-only log of every agent action & financial execution
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  request_id text,
  agent text not null,
  action text not null,
  params jsonb,
  approval_id uuid,
  result jsonb,
  created_at timestamptz not null default now()
);

-- Webhook Events: Incoming PayPal webhooks with deduplication
create table if not exists webhook_events (
  id text primary key,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error text
);

-- Chat Messages: Pip conversation drawer and proactive agent nudges
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null check (role in ('user', 'pip', 'system')),
  content text not null,
  cards jsonb,
  proactive boolean not null default false,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- LLM Cache: Key-value cache for Gemini responses
create table if not exists llm_cache (
  key text primary key,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Job Runs: History of scheduled cron executions
create table if not exists job_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  detail jsonb
);
