import { localDb, supabaseClient, isRemoteSupabaseEnabled } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { Venue } from '../schemas/domain.js';

export class VenuesRepo {
  async getById(id: string): Promise<Venue | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('venues_cache').select('*').eq('id', id).single();
      if (error || !data) return null;
      return data as Venue;
    }
    return localDb.venues.get(id) ?? null;
  }

  async getByIds(ids: string[]): Promise<Venue[]> {
    if (ids.length === 0) return [];
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('venues_cache').select('*').in('id', ids);
      if (error) throw new UpstreamError(`[VenuesRepo] Failed to fetch: ${error.message}`);
      return (data ?? []) as Venue[];
    }
    const result: Venue[] = [];
    for (const id of ids) {
      const v = localDb.venues.get(id);
      if (v) result.push(v);
    }
    return result;
  }

  async getAll(): Promise<Venue[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('venues_cache').select('*');
      if (error) throw new UpstreamError(`[VenuesRepo] Failed to fetch all: ${error.message}`);
      return (data ?? []) as Venue[];
    }
    return Array.from(localDb.venues.values());
  }

  async saveBatch(venues: Venue[]): Promise<void> {
    if (venues.length === 0) return;
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient.from('venues_cache').upsert(venues, { onConflict: 'osm_id' });
      if (error) throw new UpstreamError(`[VenuesRepo] Failed to save batch: ${error.message}`);
      return;
    }
    for (const v of venues) {
      let key = v.id;
      if (v.osm_id) {
        for (const [k, existing] of localDb.venues.entries()) {
          if (existing.osm_id === v.osm_id) {
            key = k;
            break;
          }
        }
      }
      localDb.venues.set(key, { ...v, id: key });
    }
  }

  async getPlaceQuery(queryKey: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<string[] | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('place_queries')
        .select('venue_ids, fetched_at')
        .eq('query_key', queryKey)
        .single();
      if (error || !data) return null;
      if (data.fetched_at && Date.now() - new Date(data.fetched_at).getTime() > maxAgeMs) {
        return null; // TTL expired (7 days)
      }
      return (data.venue_ids ?? []) as string[];
    }
    const entry = localDb.place_queries.get(queryKey);
    if (!entry) return null;
    if (Array.isArray(entry)) {
      return entry;
    }
    if (entry.fetched_at && Date.now() - new Date(entry.fetched_at).getTime() > maxAgeMs) {
      return null; // TTL expired (7 days)
    }
    return entry.venue_ids;
  }

  async savePlaceQuery(queryKey: string, venueIds: string[]): Promise<void> {
    const fetched_at = new Date().toISOString();
    if (isRemoteSupabaseEnabled && supabaseClient) {
      await supabaseClient.from('place_queries').upsert({
        query_key: queryKey,
        venue_ids: venueIds,
        fetched_at
      });
      return;
    }
    localDb.place_queries.set(queryKey, { venue_ids: venueIds, fetched_at });
  }
}

export const venuesRepo = new VenuesRepo();
