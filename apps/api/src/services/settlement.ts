import { groupsRepo } from '../repos/groups.js';
import { settlementsRepo } from '../repos/settlements.js';
import { auditRepo } from '../repos/audit.js';
import { paypalService } from './paypal.js';
import { moneyService } from './money.js';
import { eventBus } from '../core/events.js';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import type { GroupPayment } from '../schemas/domain.js';

export interface SettleInput {
  groupId: string;
  paymentId: string;
  captureId: string;
  /** Decimal string from PayPal, e.g. "33.34". */
  amountValue?: string;
  currency?: string;
  /** Merchant id PayPal reports as the receiver, when the event/response includes it. */
  payeeMerchantId?: string;
  source: 'capture_route' | 'webhook';
}

export type RejectCode =
  | 'NOT_FOUND'
  | 'WRONG_GROUP'
  | 'MISSING_AMOUNT'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'PAYEE_MISMATCH';

export type SettleResult =
  | { outcome: 'settled'; payment: GroupPayment; groupConfirmed: boolean }
  | { outcome: 'already_paid'; payment: GroupPayment }
  | { outcome: 'late_capture_refunded'; payment: GroupPayment | null }
  | { outcome: 'late_capture_refund_failed'; payment: GroupPayment | null }
  | { outcome: 'rejected'; code: RejectCode };

/**
 * The single place where a PayPal capture turns into a paid payment.
 * - amount AND currency must be present and match (fail closed); only simulation (non-prod) may omit them
 * - the transition is a CAS, so webhook + capture route can race safely
 * - money captured for a payment/group that is no longer payable is refunded automatically
 *   (a refund returns the payer's own money; it is not money out for the organizer)
 */
export async function settlePayment(input: SettleInput): Promise<SettleResult> {
  const group = await groupsRepo.getGroupById(input.groupId);
  if (!group) return { outcome: 'rejected', code: 'NOT_FOUND' };
  const payment = await groupsRepo.getPaymentById(input.paymentId);
  if (!payment) return { outcome: 'rejected', code: 'NOT_FOUND' };
  if (payment.group_id !== group.id) return { outcome: 'rejected', code: 'WRONG_GROUP' };

  const mustHaveAmount = !config.PAYPAL_SIMULATE;
  if (mustHaveAmount && (!input.amountValue || !input.currency)) {
    return { outcome: 'rejected', code: 'MISSING_AMOUNT' };
  }
  // The money must have gone to OUR merchant account. Checked only when both sides are known (webhooks for some event
  // types omit the payee); a mismatch is never settled and never silently accepted.
  if (input.payeeMerchantId && config.PAYPAL_PAYEE_MERCHANT_ID && input.payeeMerchantId !== config.PAYPAL_PAYEE_MERCHANT_ID) {
    return { outcome: 'rejected', code: 'PAYEE_MISMATCH' };
  }
  if (input.currency && input.currency !== group.currency) {
    return { outcome: 'rejected', code: 'CURRENCY_MISMATCH' };
  }
  if (input.amountValue) {
    let minor: number;
    try {
      minor = moneyService.toMinorUnits(input.amountValue, group.currency);
    } catch {
      return { outcome: 'rejected', code: 'AMOUNT_MISMATCH' };
    }
    if (minor !== payment.share_minor) return { outcome: 'rejected', code: 'AMOUNT_MISMATCH' };
  }

  if (payment.status === 'paid') {
    // A retried webhook heals a ledger write that failed after the payment was marked paid.
    await recordCapture(group, payment, payment.capture_id ?? input.captureId, input.source);
    return { outcome: 'already_paid', payment };
  }
  if (payment.status === 'refunded') return { outcome: 'late_capture_refunded', payment };

  const payable =
    (payment.status === 'sent' || payment.status === 'viewed' || payment.status === 'capturing') &&
    group.status === 'pending';

  if (payable) {
    const paid = await groupsRepo.transitionPaymentToPaid(payment.id, input.captureId, new Date().toISOString());
    if (paid) {
      await recordCapture(group, payment, input.captureId, input.source);
      const all = await groupsRepo.getPaymentsByGroupId(group.id);
      const groupConfirmed = all.every((p) => p.status === 'paid');
      if (groupConfirmed) {
        await groupsRepo.updateGroupStatus(group.id, 'confirmed');
        eventBus.emitEvent('group.confirmed', { group: { ...group, status: 'confirmed' } });
      }
      eventBus.emitEvent('group.payment_updated', { groupId: group.id, paymentId: payment.id, status: 'paid' });
      return { outcome: 'settled', payment: paid, groupConfirmed };
    }
    // Lost the race: someone else settled it (or it was cancelled in between).
    const fresh = await groupsRepo.getPaymentById(payment.id);
    if (fresh?.status === 'paid') {
      await recordCapture(group, payment, fresh.capture_id ?? input.captureId, input.source);
      return { outcome: 'already_paid', payment: fresh };
    }
  }

  return refundLateCapture(payment.id, input.captureId, input.source);
}

type LedgerGroup = { id: string; organizer_id: string; currency: string };

/** Records the capture in the append-only ledger (idempotent per payment). */
export async function recordCapture(
  group: LedgerGroup,
  payment: { id: string; share_minor: number },
  captureId: string,
  source: string
): Promise<void> {
  await settlementsRepo.record({
    group_id: group.id,
    payment_id: payment.id,
    organizer_id: group.organizer_id,
    kind: 'capture',
    amount_minor: payment.share_minor,
    currency: group.currency,
    paypal_capture_id: captureId,
    paypal_refund_id: null,
    actor: source === 'webhook' ? 'webhook' : source === 'capture_route' ? 'friend_capture' : 'system'
  });
}

/** Records a refund, first making sure its capture is on the ledger (older payments pre-date the ledger). */
export async function recordRefund(
  group: LedgerGroup,
  payment: { id: string; share_minor: number },
  captureId: string,
  refundId: string,
  actor: 'organizer' | 'system' | 'webhook'
): Promise<void> {
  await recordCapture(group, payment, captureId, 'system');
  await settlementsRepo.record({
    group_id: group.id,
    payment_id: payment.id,
    organizer_id: group.organizer_id,
    kind: 'refund',
    amount_minor: payment.share_minor,
    currency: group.currency,
    paypal_capture_id: captureId,
    paypal_refund_id: refundId,
    actor
  });
}

/** Money was captured but the payment/group can no longer be paid. Refund it right away. */
export async function refundLateCapture(
  paymentId: string,
  captureId: string,
  source: string
): Promise<SettleResult> {
  const payment = await groupsRepo.getPaymentById(paymentId);
  const group = payment ? await groupsRepo.getGroupById(payment.group_id) : null;
  // The money WAS captured, whether or not the refund below succeeds: the ledger must show it is being held.
  if (payment && group) await recordCapture(group, payment, captureId, source);
  try {
    const refund = await paypalService.refundCapture(captureId, 'Outing no longer payable; automatic refund');
    const updated = await groupsRepo.updatePaymentStatus(
      paymentId,
      'refunded',
      captureId,
      undefined,
      undefined,
      undefined,
      refund.refundId
    );
    if (payment && group) await recordRefund(group, payment, captureId, refund.refundId, source === 'webhook' ? 'webhook' : 'system');
    await auditRepo.log({
      agent: 'system',
      action: 'late_capture_auto_refund',
      params: { paymentId, captureId, source },
      result: { refundId: refund.refundId }
    });
    return { outcome: 'late_capture_refunded', payment: updated ?? payment };
  } catch (err) {
    logger.error('[Settlement] Late capture refund FAILED; manual follow-up required', { paymentId, captureId });
    await auditRepo.log({
      agent: 'system',
      action: 'late_capture_refund_failed',
      params: { paymentId, captureId, source },
      result: { error: 'REFUND_FAILED' }
    });
    // Keep the capture id on the record so the reconciler / an operator can refund it.
    await groupsRepo.updatePaymentStatus(paymentId, payment?.status ?? 'failed', captureId);
    return { outcome: 'late_capture_refund_failed', payment };
  }
}
