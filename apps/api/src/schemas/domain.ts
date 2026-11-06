import { z } from 'zod';
import { CurrencySchema } from '../core/currency.js';
export { CurrencySchema };

// Profile schema matching profiles table
export const ProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  timezone: z.string().default('UTC'),
  home_lat: z.number().nullable().optional(),
  home_lng: z.number().nullable().optional(),
  home_label: z.string().nullable().optional(),
  max_distance_km: z.number().min(1).max(50).default(5),
  guilt_free_cap_minor: z.number().int().nonnegative().default(0),
  per_action_cap_minor: z.number().int().nonnegative().default(0),
  weekly_cap_minor: z.number().int().nonnegative().default(0),
  currency: CurrencySchema.default('USD'),
  opt_in_mood: z.boolean().default(false),
  opt_in_tracking: z.boolean().default(false),
  exploration_level: z.enum(['off', 'low', 'normal']).default('normal'),
  created_at: z.string().datetime().optional()
});
export type Profile = z.infer<typeof ProfileSchema>;

// Preferences schema matching preferences table
export const PreferencesSchema = z.object({
  user_id: z.string().uuid(),
  interests: z.array(z.string()).default([]),
  social_pref: z.enum(['solo', 'social', 'mixed']).nullable().optional(),
  vibe_pref: z.enum(['quiet', 'lively', 'mixed']).nullable().optional()
});
export type Preferences = z.infer<typeof PreferencesSchema>;

// Subscription schema matching subscriptions table
export const SubscriptionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  merchant: z.string(),
  amount_minor: z.number().int().nonnegative(),
  interval: z.enum(['weekly', 'monthly', 'yearly']),
  paypal_subscription_id: z.string().nullable().optional(),
  status: z.enum(['active', 'cancel_pending', 'cancelled']).default('active'),
  last_used_signal: z.string().datetime().nullable().optional(),
  flagged_ghost: z.boolean().default(false),
  ghost_reason: z.string().nullable().optional(),
  ghost_snoozed_until: z.string().datetime().nullable().optional(),
  cancelled_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime().optional()
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

// Venue schema matching venues_cache table
export const VenueSchema = z.object({
  id: z.string().uuid(),
  osm_id: z.string().nullable().optional(),
  name: z.string(),
  category: z.string(),
  lat: z.number(),
  lng: z.number(),
  tags: z.record(z.string(), z.unknown()).default({}),
  est_cost_low_minor: z.number().int().nullable().optional(),
  est_cost_high_minor: z.number().int().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  cost_source: z.enum(['estimate', 'price_level']).nullable().optional(),
  cost_confidence: z.enum(['low', 'medium', 'high']).nullable().optional(),
  quietness: z.enum(['quiet', 'mixed', 'lively', 'unknown']).default('unknown'),
  fetched_at: z.string().datetime().optional(),
  cost_estimated_at: z.string().datetime().nullable().optional()
});
export type Venue = z.infer<typeof VenueSchema>;

// Plan schema matching plans table
export const PlanSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  week: z.string(),
  mood: z.enum(['drained', 'okay', 'great']).nullable().optional(),
  group_size: z.number().int().min(1).max(20).default(1),
  budget_minor: z.number().int(),
  radius_km: z.number(),
  status: z.enum(['open', 'accepted', 'closed']).default('open'),
  occasion_type: z.enum(['everyday', 'weekend', 'holiday', 'getaway']).default('weekend'),
  occasion_id: z.string().uuid().nullable().optional(),
  habit_id: z.string().uuid().nullable().optional(),
  created_at: z.string().datetime().optional()
});
export type Plan = z.infer<typeof PlanSchema>;

// Suggestion schema matching suggestions table
export const SuggestionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  plan_id: z.string().uuid(),
  venue_id: z.string().uuid(),
  slot: z.enum(['comfort', 'stretch', 'new']),
  features: z.record(z.string(), z.string()),
  headline: z.string().nullable().optional(),
  why: z.string().nullable().optional(),
  reason_tags: z.array(z.string()).default([]),
  shown_at: z.string().datetime().optional(),
  outcome: z.enum(['accepted', 'modified', 'rejected', 'ignored']).nullable().optional(),
  reject_reason: z.enum(['too_far', 'too_pricey', 'not_my_vibe', 'did_recently']).nullable().optional(),
  decided_at: z.string().datetime().nullable().optional()
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

// Transaction schema matching transactions table
export const TransactionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  source: z.enum(['paypal_sandbox', 'seeded', 'manual']),
  source_ref: z.string(),
  occurred_at: z.string().datetime(),
  amount_minor: z.number().int(),
  currency: z.string().length(3),
  merchant_raw: z.string(),
  merchant_norm: z.string(),
  kind: z.enum(['essential', 'leisure', 'subscription']).nullable().optional(),
  category: z.string().nullable().optional(),
  venue_id: z.string().uuid().nullable().optional(),
  linked_suggestion_id: z.string().uuid().nullable().optional(),
  match_type: z.enum(['followed', 'organic', 'ignored']).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  needs_question: z.boolean().default(false),
  user_rating: z.enum(['worth_it', 'okay', 'too_much']).nullable().optional(),
  excluded: z.boolean().default(false)
});
export type Transaction = z.infer<typeof TransactionSchema>;

// Bandit State schema matching bandit_state table
export const BanditStateSchema = z.object({
  user_id: z.string().uuid(),
  feature: z.string(),
  value: z.string(),
  alpha: z.number().min(1).default(1),
  beta: z.number().min(1).default(1),
  updated_at: z.string().datetime().optional()
});
export type BanditState = z.infer<typeof BanditStateSchema>;

// Learning Event schema matching learning_events table
export const LearningEventSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  event_type: z.string(),
  weight: z.number(),
  features: z.record(z.string(), z.string()),
  confidence: z.number().default(1),
  source_table: z.string().nullable().optional(),
  source_id: z.string().uuid().nullable().optional(),
  reverted: z.boolean().default(false),
  created_at: z.string().datetime().optional()
});
export type LearningEvent = z.infer<typeof LearningEventSchema>;

// Group & Group Payment schemas
export const GroupSchema = z.object({
  id: z.string().uuid(),
  organizer_id: z.string().uuid(),
  suggestion_id: z.string().uuid().nullable().optional(),
  transaction_id: z.string().uuid().nullable().optional(),
  total_minor: z.number().int().positive(),
  currency: CurrencySchema,
  deadline: z.string().datetime(),
  status: z.enum(['draft', 'pending', 'confirmed', 'refunding', 'refunded', 'cancelled']).default('draft'),
  created_at: z.string().datetime().optional()
});
export type Group = z.infer<typeof GroupSchema>;

export const GroupPaymentSchema = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid(),
  friend_name: z.string(),
  contact: z.string(),
  share_minor: z.number().int().positive(),
  public_token: z.string(),
  paypal_ref: z.string().nullable().optional(),
  pay_url: z.string().nullable().optional(),
  capture_id: z.string().nullable().optional(),
  refund_ref: z.string().nullable().optional(),
  status: z.enum(['draft', 'sent', 'viewed', 'capturing', 'paid', 'failed', 'refunded', 'cancelled']).default('draft'),
  capture_started_at: z.string().datetime().nullable().optional(),
  viewed_at: z.string().datetime().nullable().optional(),
  paid_at: z.string().datetime().nullable().optional(),
  last_nudged_at: z.string().datetime().nullable().optional()
});
export type GroupPayment = z.infer<typeof GroupPaymentSchema>;

// Mood Checkin schema matching mood_checkins table
export const MoodCheckinSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  week: z.string(),
  level: z.enum(['drained', 'okay', 'great'])
});
export type MoodCheckin = z.infer<typeof MoodCheckinSchema>;

// Approval schema matching approvals table
export const ApprovalActionTypeSchema = z.enum([
  'cancel_subscription',
  'send_requests',
  'refund_group',
  'vault_move',
  'reset_learning',
  'delete_data',
  'pocket_move',
  'change_caps',
  'change_currency'
]);
export type ApprovalActionType = z.infer<typeof ApprovalActionTypeSchema>;

export const ApprovalSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  action_type: ApprovalActionTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  preview: z.string(),
  amount_minor: z.number().int().default(0),
  money_out_minor: z.number().int().default(0),
  status: z.enum([
    'pending',
    'approved',
    'executing',
    'executed',
    'failed',
    'denied',
    'expired',
    'cancelled'
  ]).default('pending'),
  idempotency_key: z.string(),
  challenge_nonce: z.string().nullable().optional(),
  challenge_expires_at: z.string().datetime().nullable().optional(),
  challenge_fingerprint: z.string().nullable().optional(),
  execution_outcome: z.record(z.string(), z.unknown()).nullable().optional(),
  retry_count: z.number().int().default(0),
  decision_idempotency_key: z.string().nullable().optional(),
  decision_response: z.record(z.string(), z.unknown()).nullable().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  expires_at: z.string().datetime(),
  created_at: z.string().datetime().optional(),
  decided_at: z.string().datetime().nullable().optional(),
  executed_at: z.string().datetime().nullable().optional()
});
export type Approval = z.infer<typeof ApprovalSchema>;

// Audit Log entry schema
export const AuditLogSchema = z.object({
  id: z.number().int().optional(),
  user_id: z.string().uuid().nullable().optional(),
  request_id: z.string().nullable().optional(),
  agent: z.string(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()).nullable().optional(),
  approval_id: z.string().uuid().nullable().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  created_at: z.string().datetime().optional()
});
export type AuditLogEntry = z.infer<typeof AuditLogSchema>;

// Chat Message schema
export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: z.enum(['user', 'pip', 'system']),
  content: z.string(),
  cards: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  proactive: z.boolean().default(false),
  read: z.boolean().default(false),
  created_at: z.string().datetime().optional()
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// Occasions, Habits, Pockets, Holidays
export const HabitSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  day_of_week: z.number().int().min(0).max(6),
  time_bucket: z.enum(['morning', 'afternoon', 'evening', 'night']),
  category: z.string(),
  typical_amount_minor: z.number().int(),
  occurrences: z.number().int(),
  window_weeks: z.number().int().default(6),
  status: z.enum(['active', 'paused', 'removed']).default('active'),
  paused_until: z.string().datetime().nullable().optional(),
  last_seen_at: z.string().datetime().nullable().optional()
});
export type Habit = z.infer<typeof HabitSchema>;

export const OccasionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  type: z.enum(['everyday', 'weekend', 'holiday', 'getaway']),
  title: z.string(),
  starts_on: z.string(),
  ends_on: z.string(),
  holiday_id: z.string().uuid().nullable().optional(),
  habit_id: z.string().uuid().nullable().optional(),
  budget_minor: z.number().int().default(0),
  status: z.enum(['upcoming', 'planned', 'done', 'skipped']).default('upcoming'),
  nudged_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime().optional()
});
export type Occasion = z.infer<typeof OccasionSchema>;

export const PocketSchema = z.object({
  user_id: z.string().uuid(),
  kind: z.enum(['weekly', 'holiday', 'getaway']),
  balance_minor: z.number().int().nonnegative().default(0),
  target_minor: z.number().int().nullable().optional(),
  is_simulated: z.boolean().default(true)
});
export type Pocket = z.infer<typeof PocketSchema>;

export const HolidaySchema = z.object({
  id: z.string().uuid(),
  region: z.string(),
  name: z.string(),
  date: z.string(),
  kind: z.enum(['public', 'festival', 'optional'])
});
export type Holiday = z.infer<typeof HolidaySchema>;

export const VaultSchema = z.object({
  user_id: z.string().uuid(),
  goal_balance_minor: z.number().int().default(0),
  rollover_balance_minor: z.number().int().default(0),
  is_simulated: z.boolean().default(true)
});
export type Vault = z.infer<typeof VaultSchema>;

// User Leave Days schema matching user_leave_days table
export const UserLeaveDaySchema = z.object({
  user_id: z.string().uuid(),
  day: z.string()
});
export type UserLeaveDay = z.infer<typeof UserLeaveDaySchema>;

// Getaway Destination schema matching getaway_destinations table
export const GetawayDestinationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  region: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  travel_hours_from: z.record(z.string(), z.unknown()).default({}),
  cost_per_day_low_minor: z.number().int().nullable().optional(),
  cost_per_day_high_minor: z.number().int().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  best_months: z.array(z.number().int()).default([]),
  tags: z.array(z.string()).default([]),
  geocode_verified: z.boolean().default(false),
  source: z.string().default('gemini'),
  generated_at: z.string().datetime().optional()
});
export type GetawayDestination = z.infer<typeof GetawayDestinationSchema>;

// Nudge Settings schema matching nudge_settings table
export const NudgeSettingsSchema = z.object({
  user_id: z.string().uuid(),
  quiet_start: z.string().default('22:00'),
  quiet_end: z.string().default('08:00'),
  weekly_limit: z.number().int().default(2),
  everyday: z.boolean().default(true),
  holiday: z.boolean().default(true),
  getaway: z.boolean().default(true)
});
export type NudgeSettings = z.infer<typeof NudgeSettingsSchema>;
