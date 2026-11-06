import { localDb, supabaseClient, isRemoteSupabaseEnabled } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';

export class WebhooksRepo {
  async insertEvent(eventId: string, eventType: string, payload: unknown): Promise<boolean> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { error } = await supabaseClient
        .from('webhook_events')
        .insert({
          id: eventId,
          event_type: eventType,
          payload,
          status: 'processing',
          received_at: new Date().toISOString()
        });
      if (error) {
        if (error.code === '23505') {
          // Check existing event status; allow failed to retry
          const { data: existing, error: fetchErr } = await supabaseClient
            .from('webhook_events')
            .select('status')
            .eq('id', eventId)
            .maybeSingle();

          if (fetchErr) throw fetchErr;

          if (existing && existing.status === 'failed') {
            const { error: updateErr } = await supabaseClient
              .from('webhook_events')
              .update({ status: 'processing', error: null })
              .eq('id', eventId);
            if (updateErr) throw updateErr;
            return true;
          }

          // Otherwise duplicate (processing or processed)
          return false;
        }
        // For any other error, throw
        throw new UpstreamError(`[WebhooksRepo] Failed to insert event: ${error.message} (${error.code})`);
      }
      return true;
    }

    const existing = localDb.webhook_events.get(eventId);
    if (existing) {
      if (existing.status === 'failed') {
        existing.status = 'processing';
        existing.error = undefined;
        return true;
      }
      return false; // Duplicate
    }

    localDb.webhook_events.set(eventId, {
      id: eventId,
      event_type: eventType,
      payload,
      status: 'processing',
      created_at: new Date().toISOString()
    });
    return true;
  }

  async updateEventStatus(eventId: string, status: string, error?: string): Promise<void> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const updateData: Record<string, unknown> = {
        status,
        error: error ?? null
      };
      if (status === 'processed') {
        updateData['processed_at'] = new Date().toISOString();
      }
      const { error: updateErr } = await supabaseClient
        .from('webhook_events')
        .update(updateData)
        .eq('id', eventId);
      if (updateErr) throw new UpstreamError(`[WebhooksRepo] Failed to update event status: ${updateErr.message}`);
      return;
    }

    const ev = localDb.webhook_events.get(eventId);
    if (ev) {
      ev.status = status;
      ev.error = error;
    }
  }
}

export const webhooksRepo = new WebhooksRepo();
