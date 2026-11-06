import { DEMO_USER } from './demo.js';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AppError, UpstreamError } from './errors.js';
import { config } from './config.js';
import { logger } from './logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  Profile,
  Preferences,
  Subscription,
  Venue,
  Plan,
  Suggestion,
  Transaction,
  LearningEvent,
  BanditState,
  Group,
  GroupPayment,
  MoodCheckin,
  Vault,
  Approval,
  AuditLogEntry,
  ChatMessage,
  Habit,
  Occasion,
  Pocket,
  Holiday,
  UserLeaveDay,
  GetawayDestination,
  NudgeSettings
} from '../schemas/domain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-Memory store for local dual-driver
export interface LocalDatabaseState {
  profiles: Map<string, Profile>;
  preferences: Map<string, Preferences>;
  subscriptions: Map<string, Subscription>;
  venues: Map<string, Venue>;
  place_queries: Map<string, string[] | { venue_ids: string[]; fetched_at: string }>;
  plans: Map<string, Plan>;
  suggestions: Map<string, Suggestion>;
  transactions: Map<string, Transaction>;
  learning_events: LearningEvent[];
  bandit_state: Map<string, BanditState>;
  groups: Map<string, Group>;
  group_payments: Map<string, GroupPayment>;
  mood_checkins: Map<string, MoodCheckin>;
  vault: Map<string, Vault>;
  approvals: Map<string, Approval>;
  audit_log: AuditLogEntry[];
  chat_messages: ChatMessage[];
  habits: Map<string, Habit>;
  occasions: Map<string, Occasion>;
  pockets: Map<string, Pocket>;
  holidays: Map<string, Holiday>;
  user_leave_days: Map<string, UserLeaveDay>;
  getaway_destinations: Map<string, GetawayDestination>;
  nudge_settings: Map<string, NudgeSettings>;
  webhook_events: Map<string, { id: string; event_type: string; payload: unknown; status: string; created_at: string; error?: string }>;
  step_up: Map<string, LocalStepUpCred>;
  /** WebAuthn credentials keyed by credential_id (mirrors webauthn_credentials; credential_id is globally unique). */
  webauthn_credentials: Map<string, LocalWebAuthnCred>;
  /** Append-only settlement ledger keyed by `${payment_id}:${kind}` (mirrors settlements). */
  settlements: Map<string, LocalSettlement>;
  /** Single-use ceremony challenges keyed by `${user_id}:${purpose}` (mirrors webauthn_challenges). */
  webauthn_challenges: Map<string, LocalWebAuthnChallenge>;
  job_runs: Map<string, LocalJobRun>;
  /** Tombstones for erased accounts (mirrors erased_users). */
  erased_users: Map<string, { erased_at: string; auth_deleted_at?: string }>;
  /** Step-up factor change notifications (mirrors security_notifications). */
  security_notifications: LocalSecurityNotification[];
}

/** Mirrors step_up_credentials: PIN and TOTP are both optional, one shared failure counter. */
export interface LocalStepUpCred {
  user_id: string;
  pin_salt: string | null;
  pin_hash: string | null;
  failed_attempts: number;
  locked_until: string | null;
  enrolled_at: string;
  totp_secret_enc?: string | null;
  totp_pending_secret_enc?: string | null;
  totp_confirmed_at?: string | null;
  totp_last_step?: number;
  /** Cooldown anchor: when a factor was last enrolled, replaced, reset or its last factor removed. */
  factor_changed_at?: string | null;
}

/** Mirrors security_notifications: user-visible record of a change to the user's step-up factors. */
export interface LocalSecurityNotification {
  id: string;
  user_id: string;
  kind: 'factor_enrolled' | 'factor_replaced' | 'factor_removed';
  factor: 'pin' | 'totp' | 'passkey';
  message: string;
  created_at: string;
}

export interface LocalWebAuthnCred {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string[] | null;
  device_type: 'singleDevice' | 'multiDevice' | null;
  backed_up: boolean;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface LocalSettlement {
  id: string;
  group_id: string;
  payment_id: string;
  organizer_id: string | null;
  kind: 'capture' | 'refund';
  amount_minor: number;
  currency: string;
  paypal_capture_id: string;
  paypal_refund_id: string | null;
  actor: 'friend_capture' | 'webhook' | 'organizer' | 'system';
  created_at: string;
}

export interface LocalWebAuthnChallenge {
  user_id: string;
  purpose: 'register' | 'enroll';
  challenge: string;
  expires_at: string;
}

export interface LocalJobRun {
  id: string;
  job: string;
  period_key?: string;
  lease_key?: string;
  lease_expires_at?: string;
  started_at: string;
  finished_at?: string;
  status: 'running' | 'ok' | 'failed';
  detail?: Record<string, unknown>;
}

export const localDb: LocalDatabaseState = {
  profiles: new Map(),
  preferences: new Map(),
  subscriptions: new Map(),
  venues: new Map(),
  place_queries: new Map(),
  plans: new Map(),
  suggestions: new Map(),
  transactions: new Map(),
  learning_events: [],
  bandit_state: new Map(),
  groups: new Map(),
  group_payments: new Map(),
  mood_checkins: new Map(),
  vault: new Map(),
  approvals: new Map(),
  audit_log: [],
  chat_messages: [],
  habits: new Map(),
  occasions: new Map(),
  pockets: new Map(),
  holidays: new Map(),
  user_leave_days: new Map(),
  getaway_destinations: new Map(),
  nudge_settings: new Map(),
  webhook_events: new Map(),
  step_up: new Map(),
  webauthn_credentials: new Map(),
  settlements: new Map(),
  webauthn_challenges: new Map(),
  job_runs: new Map(),
  erased_users: new Map(),
  security_notifications: []
};

// Seed local database with Aarav's demo ledger & fallback venues
export function initLocalSeed(): void {
  // 1. Load Fallback Venues
  try {
    const venuesPath = path.resolve(__dirname, '../../../../data/fallback_venues.json');
    if (fs.existsSync(venuesPath)) {
      const rawVenues = fs.readFileSync(venuesPath, 'utf8');
      const venuesList = JSON.parse(rawVenues) as Venue[];
      for (const v of venuesList) {
        localDb.venues.set(v.id, v);
      }
    }
  } catch (err) {
    logger.warn('[Database] Could not read fallback_venues.json:', { error: String(err) });
  }

  // 2. Seed Aarav's Profile
  const demoUserId: string = DEMO_USER.id;
  localDb.profiles.set(demoUserId, {
    id: demoUserId,
    name: DEMO_USER.name,
    timezone: 'America/Los_Angeles',
    home_lat: 37.7749,
    home_lng: -122.4194,
    home_label: 'Mission District, San Francisco',
    max_distance_km: 8.0,
    guilt_free_cap_minor: 15000, // $150.00
    per_action_cap_minor: 25000, // $250.00
    weekly_cap_minor: 50000,     // $500.00
    currency: 'USD',
    opt_in_mood: true,
    opt_in_tracking: true,
    exploration_level: 'normal',
    created_at: new Date(Date.now() - 90 * 86400000).toISOString()
  });

  // 3. Seed Preferences
  localDb.preferences.set(demoUserId, {
    user_id: demoUserId,
    interests: ['cafes', 'gaming', 'sports', 'outdoors'],
    social_pref: 'mixed',
    vibe_pref: 'quiet'
  });

  // 4. Seed Subscriptions (with 3 Flagged Ghosts)
  localDb.subscriptions.set('b0000000-0000-4000-8000-000000000001', {
    id: 'b0000000-0000-4000-8000-000000000001',
    user_id: demoUserId,
    merchant: 'CloudGym Deluxe Pass',
    amount_minor: 4900, // $49.00/mo ($588/yr)
    interval: 'monthly',
    paypal_subscription_id: 'I-DEMO-SUB-GYM-001',
    status: 'active',
    last_used_signal: new Date(Date.now() - 94 * 86400000).toISOString(),
    flagged_ghost: true,
    ghost_reason: 'No scan or attendance signal seen for over 90 days.',
    ghost_snoozed_until: null,
    created_at: new Date(Date.now() - 180 * 86400000).toISOString()
  });

  localDb.subscriptions.set('b0000000-0000-4000-8000-000000000002', {
    id: 'b0000000-0000-4000-8000-000000000002',
    user_id: demoUserId,
    merchant: 'StreamFlix 4K Master',
    amount_minor: 2299, // $22.99/mo
    interval: 'monthly',
    paypal_subscription_id: 'I-DEMO-SUB-FLIX-002',
    status: 'active',
    last_used_signal: new Date(Date.now() - 2 * 86400000).toISOString(),
    flagged_ghost: false,
    ghost_reason: null,
    ghost_snoozed_until: null,
    created_at: new Date(Date.now() - 200 * 86400000).toISOString()
  });

  localDb.subscriptions.set('b0000000-0000-4000-8000-000000000003', {
    id: 'b0000000-0000-4000-8000-000000000003',
    user_id: demoUserId,
    merchant: 'SoundWaves Hi-Fi Audio',
    amount_minor: 1499, // $14.99/mo ($179.88/yr)
    interval: 'monthly',
    paypal_subscription_id: 'I-DEMO-SUB-WAVE-003',
    status: 'active',
    last_used_signal: new Date(Date.now() - 60 * 86400000).toISOString(),
    flagged_ghost: true,
    ghost_reason: 'Duplicate audio tier running parallel to your primary music stream.',
    ghost_snoozed_until: null,
    created_at: new Date(Date.now() - 120 * 86400000).toISOString()
  });

  localDb.subscriptions.set('b0000000-0000-4000-8000-000000000004', {
    id: 'b0000000-0000-4000-8000-000000000004',
    user_id: demoUserId,
    merchant: 'OmniTask Pro Seat',
    amount_minor: 1200, // $12.00/mo ($144.00/yr)
    interval: 'monthly',
    paypal_subscription_id: 'I-DEMO-SUB-TASK-004',
    status: 'active',
    last_used_signal: new Date(Date.now() - 78 * 86400000).toISOString(),
    flagged_ghost: true,
    ghost_reason: 'Zero team seat logins detected across 11 weeks.',
    ghost_snoozed_until: null,
    created_at: new Date(Date.now() - 90 * 86400000).toISOString()
  });

  // 5. Seed Vault & Pockets
  localDb.vault.set(demoUserId, {
    user_id: demoUserId,
    goal_balance_minor: 4500, // $45.00
    rollover_balance_minor: 3000, // $30.00
    is_simulated: true
  });

  localDb.pockets.set(`${demoUserId}:weekly`, {
    user_id: demoUserId,
    kind: 'weekly',
    balance_minor: 14000, // $140.00 available fun money
    target_minor: null,
    is_simulated: true
  });

  localDb.pockets.set(`${demoUserId}:holiday`, {
    user_id: demoUserId,
    kind: 'holiday',
    balance_minor: 25000, // $250.00
    target_minor: 50000,
    is_simulated: true
  });

  localDb.pockets.set(`${demoUserId}:getaway`, {
    user_id: demoUserId,
    kind: 'getaway',
    balance_minor: 65000, // $650.00 (passes margin check!)
    target_minor: 100000,
    is_simulated: true
  });

  // 6. Seed Friday Habit
  localDb.habits.set(`${demoUserId}:5:evening:cafes`, {
    id: 'h0000000-0000-4000-8000-000000000001',
    user_id: demoUserId,
    day_of_week: 5,
    time_bucket: 'evening',
    category: 'cafes',
    typical_amount_minor: 2200, // $22.00
    occurrences: 4,
    window_weeks: 6,
    status: 'active',
    paused_until: null,
    last_seen_at: new Date(Date.now() - 4 * 86400000).toISOString()
  });

  // 7. Seed Initial Prior Bandit State
  const defaultPriors: [string, string, number, number][] = [
    ['category', 'cafes', 3.0, 1.0],
    ['category', 'gaming', 2.0, 1.0],
    ['category', 'sports', 2.0, 1.0],
    ['category', 'outdoors', 2.0, 1.0],
    ['price_band', 'mid', 2.5, 1.0],
    ['distance_band', '2-5km', 2.5, 1.0]
  ];
  for (const [feat, val, alpha, beta] of defaultPriors) {
    localDb.bandit_state.set(`${demoUserId}:${feat}:${val}`, {
      user_id: demoUserId,
      feature: feat,
      value: val,
      alpha,
      beta,
      updated_at: new Date().toISOString()
    });
  }

  // 8. Seed Nudge Settings
  localDb.nudge_settings.set(demoUserId, {
    user_id: demoUserId,
    quiet_start: '22:00',
    quiet_end: '08:00',
    weekly_limit: 2,
    everyday: true,
    holiday: true,
    getaway: true
  });

  // 9. Seed Demo Transactions (Spend screen AG Grid + Ledger fixed bills)
  const txnBase = Date.now();
  const demoTxns = [
    {
      id: 'c0000000-0000-4000-8000-000000000001',
      user_id: demoUserId,
      source: 'paypal_sandbox' as const,
      source_ref: 'txn_demo_essential_001',
      occurred_at: new Date(txnBase - 7 * 86400000).toISOString(),
      amount_minor: 85000,
      currency: 'USD',
      merchant_raw: 'Bay Area Property Mgmt',
      merchant_norm: 'bay area property mgmt',
      kind: 'essential' as const,
      category: 'housing',
      venue_id: null,
      linked_suggestion_id: null,
      match_type: 'ignored' as const,
      confidence: 1.0,
      needs_question: false,
      user_rating: null,
      excluded: false
    },
    {
      id: 'c0000000-0000-4000-8000-000000000002',
      user_id: demoUserId,
      source: 'paypal_sandbox' as const,
      source_ref: 'txn_demo_essential_002',
      occurred_at: new Date(txnBase - 5 * 86400000).toISOString(),
      amount_minor: 9500,
      currency: 'USD',
      merchant_raw: 'PG&E Utility',
      merchant_norm: 'pge utility',
      kind: 'essential' as const,
      category: 'utilities',
      venue_id: null,
      linked_suggestion_id: null,
      match_type: 'ignored' as const,
      confidence: 1.0,
      needs_question: false,
      user_rating: null,
      excluded: false
    },
    {
      id: 'c0000000-0000-4000-8000-000000000003',
      user_id: demoUserId,
      source: 'paypal_sandbox' as const,
      source_ref: 'txn_demo_leisure_001',
      occurred_at: new Date(txnBase - 10 * 86400000).toISOString(),
      amount_minor: 2800,
      currency: 'USD',
      merchant_raw: 'Alamo Drafthouse Cinema',
      merchant_norm: 'alamo drafthouse cinema',
      kind: 'leisure' as const,
      category: 'arts',
      venue_id: 'e0a1b2c3-0004-4000-8000-000000000004',
      linked_suggestion_id: null,
      match_type: 'followed' as const,
      confidence: 0.91,
      needs_question: false,
      user_rating: 'worth_it' as const,
      excluded: false
    },
    {
      id: 'c0000000-0000-4000-8000-000000000004',
      user_id: demoUserId,
      source: 'paypal_sandbox' as const,
      source_ref: 'txn_demo_leisure_002',
      occurred_at: new Date(txnBase - 8 * 86400000).toISOString(),
      amount_minor: 1500,
      currency: 'USD',
      merchant_raw: 'Tartine Manufactory',
      merchant_norm: 'tartine manufactory',
      kind: 'leisure' as const,
      category: 'cafes',
      venue_id: 'e0a1b2c3-0005-4000-8000-000000000005',
      linked_suggestion_id: null,
      match_type: 'organic' as const,
      confidence: 0.74,
      needs_question: false,
      user_rating: 'too_much' as const,
      excluded: false
    },
    {
      id: 'c0000000-0000-4000-8000-000000000005',
      user_id: demoUserId,
      source: 'paypal_sandbox' as const,
      source_ref: 'txn_demo_leisure_003',
      occurred_at: new Date(txnBase - 6 * 86400000).toISOString(),
      amount_minor: 4500,
      currency: 'USD',
      merchant_raw: 'SF Ceramics Workshop',
      merchant_norm: 'sf ceramics workshop',
      kind: 'leisure' as const,
      category: 'workshops',
      venue_id: 'e0a1b2c3-0006-4000-8000-000000000006',
      linked_suggestion_id: null,
      match_type: 'followed' as const,
      confidence: 0.88,
      needs_question: false,
      user_rating: 'worth_it' as const,
      excluded: false
    },
    {
      id: 'c0000000-0000-4000-8000-000000000006',
      user_id: demoUserId,
      source: 'paypal_sandbox' as const,
      source_ref: 'txn_demo_leisure_004',
      occurred_at: new Date(txnBase - 4 * 86400000).toISOString(),
      amount_minor: 2200,
      currency: 'USD',
      merchant_raw: 'Quiet Leaf Cafe',
      merchant_norm: 'quiet leaf cafe',
      kind: 'leisure' as const,
      category: 'cafes',
      venue_id: 'e0a1b2c3-0001-4000-8000-000000000001',
      linked_suggestion_id: null,
      match_type: 'organic' as const,
      confidence: 0.85,
      needs_question: false,
      user_rating: 'worth_it' as const,
      excluded: false
    },
    {
      id: 'c0000000-0000-4000-8000-000000000007',
      user_id: demoUserId,
      source: 'paypal_sandbox' as const,
      source_ref: 'txn_demo_leisure_005',
      occurred_at: new Date(txnBase - 3 * 86400000).toISOString(),
      amount_minor: 0,
      currency: 'USD',
      merchant_raw: 'Marin Headlands Trail Run',
      merchant_norm: 'marin headlands trail run',
      kind: 'leisure' as const,
      category: 'outdoors',
      venue_id: 'e0a1b2c3-0007-4000-8000-000000000007',
      linked_suggestion_id: null,
      match_type: 'organic' as const,
      confidence: 0.62,
      needs_question: false,
      user_rating: 'worth_it' as const,
      excluded: false
    },
    {
      id: 'c0000000-0000-4000-8000-000000000008',
      user_id: demoUserId,
      source: 'paypal_sandbox' as const,
      source_ref: 'txn_demo_leisure_006',
      occurred_at: new Date(txnBase - 2 * 86400000).toISOString(),
      amount_minor: 1800,
      currency: 'USD',
      merchant_raw: 'The Foundry Board Game Parlour',
      merchant_norm: 'the foundry board game parlour',
      kind: 'leisure' as const,
      category: 'gaming',
      venue_id: 'e0a1b2c3-0002-4000-8000-000000000002',
      linked_suggestion_id: null,
      match_type: 'followed' as const,
      confidence: 0.95,
      needs_question: false,
      user_rating: 'okay' as const,
      excluded: false
    },
    {
      id: 'c0000000-0000-4000-8000-000000000009',
      user_id: demoUserId,
      source: 'paypal_sandbox' as const,
      source_ref: 'txn_demo_leisure_007',
      occurred_at: new Date(txnBase - 1 * 86400000).toISOString(),
      amount_minor: 3200,
      currency: 'USD',
      merchant_raw: 'Mission Boulder Climbing Gym',
      merchant_norm: 'mission boulder climbing gym',
      kind: 'leisure' as const,
      category: 'sports',
      venue_id: 'e0a1b2c3-0003-4000-8000-000000000003',
      linked_suggestion_id: null,
      match_type: 'organic' as const,
      confidence: 0.78,
      needs_question: false,
      user_rating: null,
      excluded: false
    }
  ];
  for (const t of demoTxns) {
    localDb.transactions.set(t.id, t);
  }
}

// Check whether to use remote Supabase or Local Dual Driver
export function handleSingleResult<T>(
  data: T | null,
  error: { code?: string; message: string } | null,
  context = 'Database'
): T | null {
  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new UpstreamError(`[${context}] Database error (${error.code ?? 'UNKNOWN'}): ${error.message}`, error);
  }
  return data;
}

export const isRemoteSupabaseEnabled =
  Boolean(config.SUPABASE_URL) &&
  config.SUPABASE_URL !== 'https://demo.supabase.co' &&
  !config.SUPABASE_URL.startsWith('demo-') &&
  Boolean(config.SUPABASE_SERVICE_ROLE_KEY) &&
  config.SUPABASE_SERVICE_ROLE_KEY !== 'demo-service-role-key' &&
  !config.SUPABASE_SERVICE_ROLE_KEY.startsWith('demo-');

export let supabaseClient: SupabaseClient | null = null;

if (isRemoteSupabaseEnabled) {
  try {
    supabaseClient = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
    logger.info('[Database] Connected to remote Supabase instance', { url: config.SUPABASE_URL });
  } catch (err) {
    logger.error('[Database] Failed to initialize remote Supabase client', err);
    throw err;
  }
} else {
  if (config.NODE_ENV === 'production') {
    throw new AppError('INTERNAL_ERROR', '[Database] Remote Supabase is required in production mode. Refusing to boot with in-memory store.', 500);
  }
  initLocalSeed();
  logger.info('[Database] Operating with local dual-driver state (Aarav demo ledger seeded).');
}
