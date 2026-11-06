import { EventEmitter } from 'events';
import { logger } from './logger.js';
import type { Approval, Plan, Suggestion, Transaction, Group, Subscription } from '../schemas/domain.js';

export interface DomainEventMap {
  'subscription.cancelled': { subscription: Subscription; approval: Approval };
  'plan.generated': { plan: Plan; suggestions: Suggestion[] };
  'suggestion.decided': { suggestion: Suggestion; outcome: string; reason?: string };
  'transaction.ingested': { transaction: Transaction };
  'transaction.matched': { transaction: Transaction };
  'group.payment_updated': { groupId: string; paymentId: string; status: string };
  'group.confirmed': { group: Group };
  'group.cancelled': { group: Group };
  'approval.executed': { approval: Approval; result: unknown };
  'habit.detected': { habitId: string; userId: string; category: string };
  'pocket.moved': { userId: string; from: string; to: string; amountMinor: number };
}

export type DomainEventName = keyof DomainEventMap;

class DomainEventBus extends EventEmitter {
  emitEvent<E extends DomainEventName>(event: E, payload: DomainEventMap[E]): boolean {
    return this.emit(event, payload);
  }

  onEvent<E extends DomainEventName>(event: E, handler: (payload: DomainEventMap[E]) => void | Promise<void>): this {
    return this.on(event, (data) => {
      Promise.resolve(handler(data)).catch((err) => {
        logger.error(`[EventBus] Error handling event ${String(event)}:`, {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    });
  }
}

export const eventBus = new DomainEventBus();
