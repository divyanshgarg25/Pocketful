import { localDb, supabaseClient, isRemoteSupabaseEnabled } from '../core/database.js';
import { logger } from '../core/logger.js';
import { UpstreamError } from '../core/errors.js';
import type { AuditLogEntry } from '../schemas/domain.js';

export class AuditRepo {
  async log(entry: Omit<AuditLogEntry, 'id' | 'created_at'>): Promise<AuditLogEntry> {
    const fullEntry: AuditLogEntry = {
      ...entry,
      id: localDb.audit_log.length + 1,
      created_at: new Date().toISOString()
    };

    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('audit_log').insert(entry).select().single();
      if (error || !data) {
        logger.error('[AuditRepo] Failed to write to audit log:', { error: error?.message });
        return fullEntry;
      }
      return data as AuditLogEntry;
    }

    localDb.audit_log.push(fullEntry);
    return fullEntry;
  }

  async getByUserId(userId: string): Promise<AuditLogEntry[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('audit_log')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw new UpstreamError(`[AuditRepo] Failed to fetch: ${error.message}`);
      return (data ?? []) as AuditLogEntry[];
    }
    return localDb.audit_log
      .filter((l) => l.user_id === userId)
      .sort((a, b) => new Date(b.created_at ?? '').getTime() - new Date(a.created_at ?? '').getTime());
  }
}

export const auditRepo = new AuditRepo();
