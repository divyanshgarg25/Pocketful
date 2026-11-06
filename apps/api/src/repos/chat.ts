import { localDb, supabaseClient, isRemoteSupabaseEnabled } from '../core/database.js';
import { UpstreamError } from '../core/errors.js';
import type { ChatMessage } from '../schemas/domain.js';

export class ChatRepo {
  async getRecentMessages(userId: string, limit = 10): Promise<ChatMessage[]> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('chat_messages')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new UpstreamError(`[ChatRepo] Failed to fetch: ${error.message}`);
      return ((data ?? []) as ChatMessage[]).reverse();
    }
    return localDb.chat_messages
      .filter((m) => m.user_id === userId)
      .slice(-limit);
  }

  async append(message: ChatMessage): Promise<ChatMessage> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      const { data, error } = await supabaseClient.from('chat_messages').insert(message).select().single();
      if (error || !data) throw new UpstreamError(`[ChatRepo] Failed to append: ${error?.message}`);
      return data as ChatMessage;
    }
    localDb.chat_messages.push(message);
    return message;
  }

  async markAllRead(userId: string): Promise<void> {
    if (isRemoteSupabaseEnabled && supabaseClient) {
      await supabaseClient.from('chat_messages').update({ read: true }).eq('user_id', userId).eq('read', false);
      return;
    }
    for (const m of localDb.chat_messages) {
      if (m.user_id === userId) {
        m.read = true;
      }
    }
  }
}

export const chatRepo = new ChatRepo();
