import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { NotFoundError } from '../core/errors.js';
import { venuesRepo } from '../repos/venues.js';
import type { Venue } from '../schemas/domain.js';
import crypto from 'crypto';

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

class NominatimRateLimiter {
  private lastCall = 0;
  private readonly minIntervalMs = 1000; // 1 req/sec policy

  async acquire(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.lastCall + this.minIntervalMs - now);
    this.lastCall = now + wait;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

const nominatimLimiter = new NominatimRateLimiter();

export function stableUuidFromOsm(osmId: string): string {
  const hash = crypto.createHash('sha256').update(osmId).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class PlacesService {
  /**
   * Calculate haversine distance in kilometers between two lat/lng coordinates
   */
  haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371.0;
    const rad = (d: number) => (d * Math.PI) / 180;
    const dPhi = rad(lat2 - lat1);
    const dLambda = rad(lon2 - lon1);
    const a =
      Math.sin(dPhi / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLambda / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /**
   * Road distance approximation (1.35x haversine)
   */
  roadDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    return Math.round(this.haversineKm(lat1, lon1, lat2, lon2) * 1.35 * 10) / 10;
  }

  /**
   * Geocode an address using Nominatim with custom User-Agent
   */
  async geocodeAddress(query: string): Promise<GeocodeResult> {
    if (!query || !query.trim()) {
      throw new NotFoundError('Geocoding query cannot be empty.');
    }

    // Check if query is already numeric coordinate pair "lat, lng"
    const coordMatch = query.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (coordMatch && coordMatch[1] && coordMatch[2]) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return {
          lat,
          lng,
          displayName: `${lat.toFixed(4)}, ${lng.toFixed(4)}`
        };
      }
    }

    try {
      await nominatimLimiter.acquire();
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': config.NOMINATIM_UA },
        signal: AbortSignal.timeout(4000) // 4-second timeout guard
      });
      if (res.ok) {
        const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
        if (data && data.length > 0 && data[0]) {
          return {
            lat: parseFloat(data[0].lat),
            lng: parseFloat(data[0].lon),
            displayName: data[0].display_name
          };
        }
      }
    } catch (err) {
      logger.warn('[PlacesService] Nominatim geocode error:', {
        query,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    throw new NotFoundError(`Location "${query}" could not be resolved. Please provide a specific address or city.`);
  }

  /**
   * Reverse geocode lat/lng coordinates to a human-readable neighborhood/city
   */
  async reverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
    try {
      await nominatimLimiter.acquire();
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
      const res = await fetch(url, {
        headers: { 'User-Agent': config.NOMINATIM_UA },
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const data = (await res.json()) as {
          display_name?: string;
          address?: Record<string, string>;
        };
        if (data?.address) {
          const parts = [
            data.address.neighbourhood || data.address.suburb || data.address.subdistrict || data.address.district,
            data.address.city || data.address.town || data.address.village || data.address.county,
            data.address.state
          ].filter(Boolean);
          if (parts.length > 0) {
            return {
              lat,
              lng,
              displayName: parts.join(', ')
            };
          }
        }
        if (data?.display_name) {
          return {
            lat,
            lng,
            displayName: data.display_name.split(',').slice(0, 3).join(',').trim()
          };
        }
      }
    } catch (err) {
      logger.warn('[PlacesService] Reverse geocode error:', {
        lat,
        lng,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    const latHemi = lat >= 0 ? 'N' : 'S';
    const lngHemi = lng >= 0 ? 'E' : 'W';
    return {
      lat,
      lng,
      displayName: `${Math.abs(lat).toFixed(4)}° ${latHemi}, ${Math.abs(lng).toFixed(4)}° ${lngHemi}`
    };
  }

  /**
   * Generate deterministic cache key for place query
   */
  private generateQueryKey(lat: number, lng: number, radiusKm: number, categories: string[]): string {
    const roundedLat = Math.round(lat * 1000) / 1000;
    const roundedLng = Math.round(lng * 1000) / 1000;
    const sortedCats = [...categories].sort().join(',');
    const raw = `${roundedLat}:${roundedLng}:${radiusKm}:${sortedCats}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Fetch nearby places via Overpass API or cached/fallback venues
   */
  async findNearbyVenues(
    lat: number,
    lng: number,
    radiusKm: number,
    categories: string[]
  ): Promise<Venue[]> {
    const queryKey = this.generateQueryKey(lat, lng, radiusKm, categories);

    // 1. Check place_queries cache
    const cachedIds = await venuesRepo.getPlaceQuery(queryKey);
    if (cachedIds && cachedIds.length > 0) {
      const cached = await venuesRepo.getByIds(cachedIds);
      if (cached.length > 0) {
        return cached;
      }
    }

    // 2. Query Overpass API if PLACES_LIVE is enabled
    if (config.PLACES_LIVE) {
      try {
        const radiusMeters = Math.min(radiusKm * 1000, 25000);
        const overpassQuery = `
          [out:json][timeout:15];
          (
            node["amenity"~"cafe|cinema|arts_centre"](around:${radiusMeters},${lat},${lng});
            node["leisure"~"pitch|sports_centre|amusement_arcade|park"](around:${radiusMeters},${lat},${lng});
            way["leisure"~"pitch|sports_centre"](around:${radiusMeters},${lat},${lng});
          );
          out center tags 30;
        `;

        const res = await fetch(config.OVERPASS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(overpassQuery)}`,
          signal: AbortSignal.timeout(6000) // 6-second timeout fallback to curated venues
        });

        if (res.ok) {
          const json = (await res.json()) as {
            elements: Array<{
              id: number;
              type: string;
              lat?: number;
              lon?: number;
              center?: { lat: number; lon: number };
              tags?: Record<string, string>;
            }>;
          };

          if (json.elements && json.elements.length > 0) {
            const mappedVenues: Venue[] = [];
            for (const el of json.elements) {
              const elLat = el.lat ?? el.center?.lat;
              const elLng = el.lon ?? el.center?.lon;
              const name = el.tags?.['name'];
              if (elLat && elLng && name) {
                const category = this.mapOsmTagsToCategory(el.tags ?? {});
                if (categories.length === 0 || categories.includes(category)) {
                  const osmId = `osm_${el.type}_${el.id}`;
                  mappedVenues.push({
                    id: stableUuidFromOsm(osmId),
                    osm_id: osmId,
                    name,
                    category,
                    lat: elLat,
                    lng: elLng,
                    tags: el.tags ?? {},
                    est_cost_low_minor: null,
                    est_cost_high_minor: null,
                    currency: config.DEFAULT_CURRENCY,
                    cost_source: null,
                    cost_confidence: null,
                    quietness: category === 'cafes' || category === 'arts' ? 'quiet' : 'mixed',
                    fetched_at: new Date().toISOString(),
                    cost_estimated_at: null
                  });
                }
              }
            }

            if (mappedVenues.length > 0) {
              await venuesRepo.saveBatch(mappedVenues);
              await venuesRepo.savePlaceQuery(queryKey, mappedVenues.map((v) => v.id));
              return mappedVenues;
            }
          }
        }
      } catch (err) {
        logger.warn('[PlacesService] Overpass query failed, using fallback:', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // 3. Fallback to cached & curated venues filtered by distance
    const allFallback = await venuesRepo.getAll();
    const survivors = allFallback.filter((v) => {
      const dist = this.haversineKm(lat, lng, v.lat, v.lng);
      const matchesCategory = categories.length === 0 || categories.includes(v.category);
      return dist <= radiusKm && matchesCategory;
    });

    if (survivors.length > 0) {
      await venuesRepo.savePlaceQuery(queryKey, survivors.map((v) => v.id));
      return survivors;
    }

    // Only fallback to seeded demo venues in explicit demo mode
    if (config.DEMO_MODE) {
      return allFallback.slice(0, 5);
    }
    return [];
  }

  private mapOsmTagsToCategory(tags: Record<string, string>): string {
    if (tags['amenity'] === 'cafe') return 'cafes';
    if (tags['leisure'] === 'amusement_arcade') return 'gaming';
    if (tags['sport'] || tags['leisure'] === 'sports_centre' || tags['leisure'] === 'pitch') return 'sports';
    if (tags['craft'] || tags['workshop']) return 'workshops';
    if (tags['amenity'] === 'cinema' || tags['amenity'] === 'arts_centre') return 'arts';
    if (tags['leisure'] === 'park' || tags['natural']) return 'outdoors';
    return 'cafes';
  }
}

export const placesService = new PlacesService();
