-- Pocketful Demo Seed Data
-- Seed file: seed.sql
-- Pre-seeds Aarav's demo ledger, ghost subscriptions, 10-week history, habits, and pockets

-- 1. Demo User Profile (Aarav Sharma)
insert into profiles (
  id, name, timezone, home_lat, home_lng, home_label,
  max_distance_km, guilt_free_cap_minor, per_action_cap_minor, weekly_cap_minor,
  currency, opt_in_mood, opt_in_tracking, exploration_level, created_at
) values (
  '00000000-0000-4000-a000-000000000001',
  'Aarav Sharma',
  'America/Los_Angeles',
  37.7749,
  -122.4194,
  'Mission District, San Francisco',
  8.0,
  15000, -- $150 guilt-free weekend cap
  25000, -- $250 per-action safety cap
  50000, -- $500 weekly safety cap
  'USD',
  true,
  true,
  'normal',
  now() - interval '90 days'
) on conflict (id) do update set
  name = excluded.name,
  home_lat = excluded.home_lat,
  home_lng = excluded.home_lng,
  guilt_free_cap_minor = excluded.guilt_free_cap_minor;

-- 2. User Preferences
insert into preferences (user_id, interests, social_pref, vibe_pref)
values (
  '00000000-0000-4000-a000-000000000001',
  array['cafes', 'gaming', 'sports', 'outdoors'],
  'mixed',
  'quiet'
) on conflict (user_id) do update set
  interests = excluded.interests,
  social_pref = excluded.social_pref,
  vibe_pref = excluded.vibe_pref;

-- 3. Subscriptions (Including Flagged Ghost Subscriptions)
insert into subscriptions (
  id, user_id, merchant, amount_minor, interval, paypal_subscription_id,
  status, last_used_signal, flagged_ghost, ghost_reason
) values
(
  'b0000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-a000-000000000001',
  'CloudGym Deluxe Pass',
  4900, -- $49.00/mo
  'monthly',
  'I-DEMO-SUB-GYM-001',
  'active',
  now() - interval '94 days',
  true,
  'No scan or attendance signal seen for over 90 days.'
),
(
  'b0000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-a000-000000000001',
  'StreamFlix 4K Master',
  2299, -- $22.99/mo
  'monthly',
  'I-DEMO-SUB-FLIX-002',
  'active',
  now() - interval '2 days',
  false,
  null
),
(
  'b0000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-a000-000000000001',
  'SoundWaves Hi-Fi Audio',
  1499, -- $14.99/mo
  'monthly',
  'I-DEMO-SUB-WAVE-003',
  'active',
  now() - interval '60 days',
  true,
  'Duplicate streaming tier alongside primary active music account.'
),
(
  'b0000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-a000-000000000001',
  'OmniTask Pro Seat',
  1200, -- $12.00/mo
  'monthly',
  'I-DEMO-SUB-TASK-004',
  'active',
  now() - interval '78 days',
  true,
  'Zero recorded logins in desktop app for 11 weeks.'
) on conflict do nothing;

-- 4. Initial Vault & Pockets
insert into vault (user_id, goal_balance_minor, rollover_balance_minor, is_simulated)
values ('00000000-0000-4000-a000-000000000001', 4500, 3000, true)
on conflict (user_id) do update set
  goal_balance_minor = excluded.goal_balance_minor,
  rollover_balance_minor = excluded.rollover_balance_minor;

insert into pockets (user_id, kind, balance_minor, target_minor, is_simulated)
values
  ('00000000-0000-4000-a000-000000000001', 'weekly', 14000, null, true),
  ('00000000-0000-4000-a000-000000000001', 'holiday', 25000, 50000, true),
  ('00000000-0000-4000-a000-000000000001', 'getaway', 65000, 100000, true)
on conflict (user_id, kind) do update set balance_minor = excluded.balance_minor;

-- 5. Seed Venues
insert into venues_cache (
  id, osm_id, name, category, lat, lng,
  est_cost_low_minor, est_cost_high_minor, currency,
  cost_source, cost_confidence, quietness, tags
) values
(
  'e0a1b2c3-0001-4000-8000-000000000001',
  'osm_node_101',
  'Quiet Leaf Cafe',
  'cafes',
  37.7749,
  -122.4194,
  800,
  1400,
  'USD',
  'estimate',
  'high',
  'quiet',
  '{"amenity": "cafe", "coffee": "roastery"}'::jsonb
),
(
  'e0a1b2c3-0002-4000-8000-000000000002',
  'osm_node_102',
  'The Foundry Board Game Parlour',
  'gaming',
  37.7810,
  -122.4120,
  1200,
  2000,
  'USD',
  'estimate',
  'high',
  'mixed',
  '{"leisure": "amusement_arcade", "board_games": "yes"}'::jsonb
),
(
  'e0a1b2c3-0003-4000-8000-000000000003',
  'osm_node_103',
  'Mission Boulder Climbing Gym',
  'sports',
  37.7650,
  -122.4210,
  2200,
  3000,
  'USD',
  'estimate',
  'high',
  'lively',
  '{"sport": "climbing", "leisure": "sports_centre"}'::jsonb
) on conflict (id) do nothing;

-- 6. Seed Habits (Your Rhythm)
insert into habits (
  user_id, day_of_week, time_bucket, category,
  typical_amount_minor, occurrences, window_weeks, status, last_seen_at
) values (
  '00000000-0000-4000-a000-000000000001',
  5, -- Friday
  'evening',
  'cafes',
  2200, -- $22.00
  4,
  6,
  'active',
  now() - interval '4 days'
) on conflict do nothing;

-- 7. Seed Holidays & Regional Calendar
insert into holidays (region, name, date, kind) values
  ('US-CA', 'Memorial Day Weekend', current_date + interval '18 days', 'public'),
  ('US-CA', 'Summer Solstice Arts Festival', current_date + interval '35 days', 'festival')
on conflict (region, name, date) do nothing;
