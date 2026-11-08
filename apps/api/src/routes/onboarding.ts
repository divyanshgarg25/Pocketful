import { DEFAULT_MEMBER_NAME } from '../core/demo.js';
import { assertValidTimeZone } from '../repos/approvals.js';
import { Router } from 'express';
import { z } from 'zod';
import { profilesRepo } from '../repos/profiles.js';
import { vaultRepo } from '../repos/vault.js';
import { placesService } from '../services/places.js';
import { sendSuccess, handleRouteError, sendError } from '../core/errors.js';
import type { AuthenticatedRequest } from '../core/auth.js';

export const onboardingRouter = Router();

const isIanaTimeZone = (tz: string): boolean => {
  try {
    assertValidTimeZone(tz);
    return true;
  } catch {
    return false;
  }
};

const OnboardingInputSchema = z.object({
  /** The user's own display name (from their sign-up). Never defaulted to a demo name. */
  name: z.string().trim().min(1).max(80).optional(),
  /** IANA zone (e.g. Asia/Kolkata). The weekly cap resets at Monday 00:00 in this zone. */
  timezone: z.string().max(64).refine(isIanaTimeZone, 'Unknown time zone').optional(),
  address: z.string().min(1),
  reachKm: z.number().min(1).max(50).default(5),
  guiltFreeCapMinor: z.number().int().nonnegative().default(15000),
  interests: z.array(z.string()).default([]),
  socialPref: z.enum(['solo', 'social', 'mixed']).default('mixed'),
  vibePref: z.enum(['quiet', 'lively', 'mixed']).default('quiet'),
  optInMood: z.boolean().default(true),
  optInTracking: z.boolean().default(true)
});

onboardingRouter.post('/api/onboarding', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const input = OnboardingInputSchema.parse(req.body);

    // Geocode address
    const geo = await placesService.geocodeAddress(input.address);

    // Update Profile
    const existing = await profilesRepo.getById(authReq.userId);
    const profile = await profilesRepo.upsert({
      id: authReq.userId,
      name: input.name ?? existing?.name ?? DEFAULT_MEMBER_NAME,
      timezone: input.timezone ?? existing?.timezone ?? 'UTC',
      home_lat: geo.lat,
      home_lng: geo.lng,
      home_label: geo.displayName,
      max_distance_km: input.reachKm,
      guilt_free_cap_minor: input.guiltFreeCapMinor,
      per_action_cap_minor: existing?.per_action_cap_minor ?? 25000,
      weekly_cap_minor: existing?.weekly_cap_minor ?? 50000,
      currency: existing?.currency ?? 'USD',
      opt_in_mood: input.optInMood,
      opt_in_tracking: input.optInTracking,
      exploration_level: existing?.exploration_level ?? 'normal',
      created_at: existing?.created_at ?? new Date().toISOString()
    });

    // Update Preferences
    const preferences = await profilesRepo.upsertPreferences({
      user_id: authReq.userId,
      interests: input.interests,
      social_pref: input.socialPref,
      vibe_pref: input.vibePref
    });

    // Ensure weekly pocket exists
    const weeklyPocket = await vaultRepo.getPocket(authReq.userId, 'weekly');
    if (!weeklyPocket) {
      await vaultRepo.updatePocket({
        user_id: authReq.userId,
        kind: 'weekly',
        // Never invent money for a real account: same as first-request provisioning in auth.ts.
        balance_minor: 0,
        target_minor: null,
        is_simulated: false
      });
    }

    sendSuccess(res, { profile, preferences, geocode: geo }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

onboardingRouter.get('/api/places/reverse-geocode', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const lat = parseFloat(req.query['lat'] as string);
    const lng = parseFloat(req.query['lng'] as string);
    if (isNaN(lat) || isNaN(lng)) {
      sendError(res, 'VALIDATION_FAILED', 'Invalid coordinates supplied', 400);
      return;
    }
    const result = await placesService.reverseGeocode(lat, lng);
    sendSuccess(res, result, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

onboardingRouter.get('/api/places/geocode', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const query = String(req.query['query'] || '').trim();
    if (!query) {
      sendError(res, 'VALIDATION_FAILED', 'Query is required', 400);
      return;
    }
    const result = await placesService.geocodeAddress(query);
    sendSuccess(res, result, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
