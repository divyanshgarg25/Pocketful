-- Pocketful Occasions & Getaways Database Schema Migration
-- Migration: 002_occasions_schema.sql
-- Conforms strictly to Pocketful Backend and Database Schema Document Section 6.5

-- Extend plans table with occasion metadata
alter table plans
  add column if not exists occasion_type text not null default 'weekend'
    check (occasion_type in ('everyday', 'weekend', 'holiday', 'getaway')),
  add column if not exists occasion_id uuid,
  add column if not exists habit_id uuid;

-- Holidays: Shared calendar & regional festival references
create table if not exists holidays (
  id uuid primary key default gen_random_uuid(),
  region text not null,
  name text not null,
  date date not null,
  kind text not null check (kind in ('public', 'festival', 'optional')),
  unique (region, name, date)
);

-- User Leave Days: Recorded PTO and bridge days for long-weekend calculation
create table if not exists user_leave_days (
  user_id uuid not null references profiles(id) on delete cascade,
  day date not null,
  primary key (user_id, day)
);

-- Habits: Mined recurring leisure patterns (Tracker rhythm)
create table if not exists habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  time_bucket text not null check (time_bucket in ('morning', 'afternoon', 'evening', 'night')),
  category text not null,
  typical_amount_minor bigint not null,
  occurrences int not null,
  window_weeks int not null default 6,
  status text not null default 'active' check (status in ('active', 'paused', 'removed')),
  paused_until timestamptz,
  last_seen_at timestamptz,
  unique (user_id, day_of_week, time_bucket, category)
);

-- Occasions: Four-tier occasions calendar (Everyday, Weekend, Holiday, Getaway)
create table if not exists occasions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  type text not null check (type in ('everyday', 'weekend', 'holiday', 'getaway')),
  title text not null,
  starts_on date not null,
  ends_on date not null,
  holiday_id uuid references holidays(id),
  habit_id uuid references habits(id),
  budget_minor bigint not null default 0,
  status text not null default 'upcoming' check (status in ('upcoming', 'planned', 'done', 'skipped')),
  nudged_at timestamptz,
  created_at timestamptz not null default now()
);

-- Pockets: Segregated financial pools (weekly, holiday pot, getaway fund)
create table if not exists pockets (
  user_id uuid not null references profiles(id) on delete cascade,
  kind text not null check (kind in ('weekly', 'holiday', 'getaway')),
  balance_minor bigint not null default 0 check (balance_minor >= 0),
  target_minor bigint,
  is_simulated boolean not null default true,
  primary key (user_id, kind)
);

-- Getaway Destinations: Proposed short-escape destinations with itineraries
create table if not exists getaway_destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  region text,
  kind text,
  lat double precision,
  lng double precision,
  travel_hours_from jsonb not null default '{}'::jsonb,
  cost_per_day_low_minor bigint,
  cost_per_day_high_minor bigint,
  currency char(3),
  best_months int[],
  tags text[] not null default '{}',
  geocode_verified boolean not null default false,
  source text not null default 'gemini',
  generated_at timestamptz not null default now()
);

-- Nudge Settings: Quiet hours and per-occasion push preferences
create table if not exists nudge_settings (
  user_id uuid primary key references profiles(id) on delete cascade,
  quiet_start time not null default '22:00',
  quiet_end time not null default '08:00',
  weekly_limit int not null default 2,
  everyday boolean not null default true,
  holiday boolean not null default true,
  getaway boolean not null default true
);
