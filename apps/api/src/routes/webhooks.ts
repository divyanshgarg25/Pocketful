import { Router, raw } from 'express';
import { paypalService } from '../services/paypal.js';
import { subscriptionsRepo } from '../repos/subscriptions.js';
import { webhooksRepo } from '../repos/webhooks.js';
import { auditRepo } from '../repos/audit.js';
import { settlePayment } from '../services/settlement.js';
import { logger } from '../core/logger.js';

export const webhooksRouter = Router();

interface PayPalAmount {
  value?: string;
  currency_code?: string;
}
interface ExtractedCapture {
  customId: string;
  captureId: string;
  amountValue?: string;
  currency?: string;
  payeeMerchantId?: string;
}

/**
 * PAYMENT.CAPTURE.COMPLETED carries custom_id/amount on the capture itself.
 * CHECKOUT.ORDER.COMPLETED carries them under purchase_units[0] (and its captures[0]).
 * Returns null unless this is a COMPLETED capture with a usable custom_id and capture id.
 */
function merchantIdOf(payee: unknown): string | undefined {
  const id = (payee as { merchant_id?: unknown } | undefined)?.merchant_id;
  return typeof id === 'string' && id ? id : undefined;
}

export function extractCapture(eventType: string, resource: Record<string, unknown>): ExtractedCapture | null {
  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    if (resource['status'] !== 'COMPLETED') return null;
    const customId = resource['custom_id'];
    const id = resource['id'];
    if (typeof customId !== 'string' || !customId.includes(':') || typeof id !== 'string') return null;
    const amt = resource['amount'] as PayPalAmount | undefined;
    return { customId, captureId: id, amountValue: amt?.value, currency: amt?.currency_code, payeeMerchantId: merchantIdOf(resource['payee']) };
  }
  if (resource['status'] !== 'COMPLETED') return null;
  const units = resource['purchase_units'];
  const pu = Array.isArray(units) ? (units[0] as Record<string, unknown> | undefined) : undefined;
  if (!pu) return null;
  const captures = (pu['payments'] as { captures?: Array<Record<string, unknown>> } | undefined)?.captures;
  const cap = captures?.[0];
  if (!cap || cap['status'] !== 'COMPLETED' || typeof cap['id'] !== 'string') return null;
  const customId = (cap['custom_id'] ?? pu['custom_id']) as unknown;
  if (typeof customId !== 'string' || !customId.includes(':')) return null;
  const amt = (cap['amount'] ?? pu['amount']) as PayPalAmount | undefined;
  return { customId, captureId: cap['id'] as string, amountValue: amt?.value, currency: amt?.currency_code, payeeMerchantId: merchantIdOf(pu['payee']) };
}

// Process PayPal Webhooks with Signature Verification, Idempotent Deduplication, and custom_id Matching
webhooksRouter.post(
  '/webhooks/paypal',
  raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    try {
      if (!req.body) {
        res.status(400).send('Empty body');
        return;
      }

      const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
      if (!rawBody || !rawBody.trim()) {
        res.status(400).send('Empty body');
        return;
      }

      const headers = {
        'paypal-auth-algo': req.headers['paypal-auth-algo'] as string,
        'paypal-cert-url': req.headers['paypal-cert-url'] as string,
        'paypal-transmission-id': req.headers['paypal-transmission-id'] as string,
        'paypal-transmission-sig': req.headers['paypal-transmission-sig'] as string,
        'paypal-transmission-time': req.headers['paypal-transmission-time'] as string
      };

      // 1. Verify PayPal webhook signature
      const verified = await paypalService.verifyWebhookSignature(headers, rawBody);
      if (!verified) {
        logger.warn('[PayPal Webhook] Signature verification failed');
        res.status(401).send('Invalid signature');
        return;
      }

      let event: {
        id: string;
        event_type: string;
        resource?: Record<string, unknown>;
      };

      try {
        event = JSON.parse(rawBody);
      } catch {
        res.status(400).send('Invalid JSON');
        return;
      }

      logger.info(`[PayPal Webhook] Received event: ${event.event_type} (${event.id})`);

      // 2. Deduplicate using webhook_events table: Insert first, skip if duplicate
      const isNew = await webhooksRepo.insertEvent(event.id, event.event_type, event);
      if (!isNew) {
        logger.info(`[PayPal Webhook] Duplicate event ignored: ${event.id}`);
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      // 3. Process Event
      try {
        if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' || event.event_type === 'CHECKOUT.ORDER.COMPLETED') {
          const extracted = extractCapture(event.event_type, event.resource ?? {});
          if (!extracted) {
            await webhooksRepo.updateEventStatus(event.id, 'ignored', 'Not a completed capture with a usable custom_id');
            res.status(200).json({ ok: true, status: 'ignored' });
            return;
          }

          const [groupId, paymentId] = extracted.customId.split(':');
          if (!groupId || !paymentId || extracted.customId.split(':').length !== 2) {
            await webhooksRepo.updateEventStatus(event.id, 'failed', 'Malformed custom_id');
            logger.error('[PayPal Webhook] ALERT malformed custom_id', { eventId: event.id });
            res.status(200).json({ ok: false, status: 'failed' }); // permanent: stop PayPal retries
            return;
          }

          const result = await settlePayment({
            groupId,
            paymentId,
            captureId: extracted.captureId,
            amountValue: extracted.amountValue,
            currency: extracted.currency,
            payeeMerchantId: extracted.payeeMerchantId,
            source: 'webhook'
          });

          if (result.outcome === 'rejected') {
            await webhooksRepo.updateEventStatus(event.id, 'failed', result.code);
            logger.error('[PayPal Webhook] ALERT capture rejected', { eventId: event.id, code: result.code });
            res.status(200).json({ ok: false, status: 'failed' }); // permanent: stop PayPal retries
            return;
          }
          if (result.outcome === 'late_capture_refund_failed') {
            await webhooksRepo.updateEventStatus(event.id, 'failed', 'Late capture refund failed');
            res.status(500).json({ ok: false }); // transient: let PayPal retry
            return;
          }

          await webhooksRepo.updateEventStatus(event.id, 'processed');
        } else if (event.event_type === 'BILLING.SUBSCRIPTION.CANCELLED') {
          const subId = event.resource?.['id'] as string;
          if (subId) {
            const target = await subscriptionsRepo.getByPayPalSubId(subId);
            if (target) {
              await subscriptionsRepo.updateStatus(target.id, 'cancelled');
            }
          }
          await webhooksRepo.updateEventStatus(event.id, 'processed');
        } else {
          // Unknown event types are safely marked as ignored
          await webhooksRepo.updateEventStatus(event.id, 'ignored');
        }

        await auditRepo.log({
          agent: 'paypal_webhook',
          action: `webhook_${event.event_type}`,
          params: { eventId: event.id },
          result: { status: 'processed' }
        });

        res.status(200).json({ ok: true });
      } catch (procErr) {
        await webhooksRepo.updateEventStatus(event.id, 'failed', 'PROCESSING_ERROR');
        throw procErr;
      }
    } catch (err) {
      logger.error('[PayPal Webhook] Processing error', err);
      res.status(500).json({ ok: false });
    }
  }
);
