import { localDb, supabaseClient, isRemoteSupabaseEnabled, handleSingleResult } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { Habit, Occasion, Holiday } from '../schemas/domain.js';

export class OccasionsRepo {
  async getHabitsForUser(userId: string): Promise<Habit[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('habits')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active');
      if (error) throw new UpstreamError(`[OccasionsRepo] Failed to fetch habits: ${error.message}`);
      return (data ?? []) as Habit[];
    }
    const result: Habit[] = [];
    for (const h of localDb.habits.values()) {
      if (h.user_id === userId && h.status === 'active') {
        result.push(h);
      }
    }
    return result;
  }

  async upsertHabit(habit: Habit): Promise<Habit> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('habits')
        .upsert(habit, { onConflict: 'user_id, day_of_week, time_bucket, category' })
        .select()
        .single();
      if (error || !data) throw new UpstreamError(`[OccasionsRepo] Failed to upsert habit: ${error?.message}`);
      return data as Habit;
    }
    const key = `${habit.user_id}:${habit.day_of_week}:${habit.time_bucket}:${habit.category}`;
    localDb.habits.set(key, habit);
    return habit;
  }

  async getOccasionsForUser(userId: string): Promise<Occasion[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('occasions')
        .select('*')
        .eq('user_id', userId)
        .order('starts_on', { ascending: true });
      if (error) throw new UpstreamError(`[OccasionsRepo] Failed to fetch occasions: ${error.message}`);
      return (data ?? []) as Occasion[];
    }
    const result: Occasion[] = [];
    for (const o of localDb.occasions.values()) {
      if (o.user_id === userId) {
        result.push(o);
      }
    }
    return result.sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  }

  async createOccasion(occasion: Occasion): Promise<Occasion> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('occasions').insert(occasion).select().single();
      if (error || !data) throw new UpstreamError(`[OccasionsRepo] Failed to create occasion: ${error?.message}`);
      return data as Occasion;
    }
    localDb.occasions.set(occasion.id, occasion);
    return occasion;
  }

  async updateOccasionStatus(id: string, status: Occasion['status']): Promise<Occasion | null> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('occasions')
        .update({ status })
        .eq('id', id)
        .select()
        .single();
      return handleSingleResult<Occasion>(data as Occasion, error, 'OccasionsRepo');
    }
    const o = localDb.occasions.get(id);
    if (!o) return null;
    const updated = { ...o, status };
    localDb.occasions.set(id, updated);
    return updated;
  }

  async getHolidays(region: string): Promise<Holiday[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('holidays')
        .select('*')
        .eq('region', region)
        .order('date', { ascending: true });
      if (error) throw new UpstreamError(`[OccasionsRepo] Failed to fetch holidays: ${error.message}`);
      return (data ?? []) as Holiday[];
    }
    const result: Holiday[] = [];
    for (const h of localDb.holidays.values()) {
      if (h.region === region) {
        result.push(h);
      }
    }
    return result.sort((a, b) => a.date.localeCompare(b.date));
  }
}

export const occasionsRepo = new OccasionsRepo();
