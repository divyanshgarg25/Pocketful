import crypto from 'crypto';
import { localDb, supabaseClient, isRemoteSupabaseEnabled, type LocalSecurityNotification } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';

export type SecurityNotification = LocalSecurityNotification;
type NewNotification = Omit<SecurityNotification, 'id' | 'created_at'>;

/**
 * User-visible record of changes to their step-up factors (enrolled / replaced / removed). Never holds secrets, codes
 * or PINs. Service-role access only; the API is the only reader and always scopes by the authenticated user.
 */
export class SecurityNotificationsRepo {
  async add(input: NewNotification): Promise<SecurityNotification> {
    const row: SecurityNotification = { ...input, id: crypto.randomUUID(), created_at: new Date().toISOString() };
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('security_notifications').insert(row).select('*').single();
      if (error) throw new UpstreamError(`[SecurityNotifications] write failed: ${error.message}`);
      return data as SecurityNotification;
    }
    localDb.security_notifications.push(row);
    return { ...row };
  }

  /** Newest first. */
  async list(userId: string, limit = 20): Promise<SecurityNotification[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('security_notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new UpstreamError(`[SecurityNotifications] read failed: ${error.message}`);
      return (data ?? []) as SecurityNotification[];
    }
    return localDb.security_notifications
      .filter((n) => n.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((n) => ({ ...n }));
  }
}

export const securityNotificationsRepo = new SecurityNotificationsRepo();
