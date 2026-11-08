import { Router } from 'express';
import { profilesRepo } from '../repos/profiles.js';
import { venuesRepo } from '../repos/venues.js';
import { placesService } from '../services/places.js';
import { moneyService } from '../services/money.js';
import { sendSuccess, handleRouteError, ValidationError, NotFoundError } from '../core/errors.js';
import type { AuthenticatedRequest } from '../core/auth.js';

export const comfortSpaceRouter = Router();

comfortSpaceRouter.post('/api/comfort-space', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const user = await profilesRepo.getById(authReq.userId);
    if (!user) throw new NotFoundError('User not found.');

    let lat = user.home_lat;
    let lng = user.home_lng;
    if (lat == null || lng == null) {
      if (user.home_label) {
        try {
          const geo = await placesService.geocodeAddress(user.home_label);
          lat = geo.lat;
          lng = geo.lng;
        } catch {
          // Unresolvable label
        }
      }
    }
    if (lat == null || lng == null) {
      throw new ValidationError(
        'Home location (home_lat, home_lng, or home_label) must be configured in your profile to find calm spots.'
      );
    }

    const allVenues = await venuesRepo.getAll();
    const calmVenues = allVenues
      .filter((v) => v.quietness === 'quiet' || v.category === 'cafes' || v.category === 'outdoors')
      .map((v) => ({
        ...v,
        distKm: placesService.roadDistanceKm(lat, lng, v.lat, v.lng)
      }))
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 3);

    const data = {
      profileSummary: `Calm spots within ${user.max_distance_km} km of your home. Quietness inferred from category proxies (cafes, bookshops, parks).`,
      venues: calmVenues.map((v) => ({
        id: v.id,
        name: v.name,
        category: v.category,
        distKm: v.distKm,
        costRange: `${moneyService.format(v.est_cost_low_minor ?? 800)}–${moneyService.format(
          v.est_cost_high_minor ?? 1400
        )}`,
        quietness: v.quietness
      }))
    };

    sendSuccess(res, data, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
