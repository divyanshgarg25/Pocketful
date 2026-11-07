import { config } from '../core/config.js';
import { moneyService } from './money.js';
import { logger } from '../core/logger.js';
import { UpstreamError } from '../core/errors.js';

export interface PayPalToken {
  accessToken: string;
  expiresAt: number;
}

export interface CreateOrderResult {
  orderId: string;
  payUrl: string;
  status: string;
}

export interface CaptureResult {
  captureId: string;
  status: string;
  amount?: string;
  currency?: string;
  /** The merchant PayPal says received the funds; compared with PAYPAL_PAYEE_MERCHANT_ID when both are known. */
  payeeMerchantId?: string;
}

export interface RefundResult {
  refundId: string;
  status: string;
}

/** The payee to put on an order, from config. Merchant id wins over email (PayPal's recommendation). */
export function buildPayee(): { merchant_id: string } | { email_address: string } | undefined {
  if (config.PAYPAL_PAYEE_MERCHANT_ID) return { merchant_id: config.PAYPAL_PAYEE_MERCHANT_ID };
  if (config.PAYPAL_PAYEE_EMAIL) return { email_address: config.PAYPAL_PAYEE_EMAIL };
  return undefined;
}

export class PayPalService {
  private tokenCache: PayPalToken | null = null;

  /**
   * Check if running in simulated mode (strictly forbidden in production)
   */
  private isSimulation(): boolean {
    if (config.NODE_ENV === 'production') {
      return false;
    }
    return Boolean(config.PAYPAL_SIMULATE);
  }

  /**
   * Acquire OAuth 2.0 Bearer Access Token with in-memory caching.
   * Throws on failure, never falls back to fake token in production.
   */
  async getAccessToken(): Promise<string> {
    if (this.isSimulation()) {
      return 'demo_sandbox_access_token_' + Date.now();
    }

    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60000) {
      return this.tokenCache.accessToken;
    }

    if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
      throw new UpstreamError('[PayPal] Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET.');
    }

    const auth = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new UpstreamError(`[PayPal] OAuth failed with status ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: now + data.expires_in * 1000
    };
    return data.access_token;
  }

  /**
   * Cancel a subscription in PayPal Sandbox
   */
  async cancelSubscription(
    subscriptionId: string,
    reason = 'Cancelled via Pocketful Guardian'
  ): Promise<{ ok: boolean; message: string }> {
    if (this.isSimulation()) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      logger.info(`[PayPal Sandbox Simulator] Cancelled subscription: ${subscriptionId} (${reason})`);
      return { ok: true, message: `Subscription ${subscriptionId} cancelled successfully in sandbox.` };
    }

    const token = await this.getAccessToken();
    const res = await fetch(`${config.PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ reason })
    });

    if (res.status === 204 || res.ok) {
      return { ok: true, message: `Subscription ${subscriptionId} cancelled.` };
    }

    const errText = await res.text();
    throw new UpstreamError(`[PayPal] Cancel failed (status ${res.status}): ${errText}`);
  }

  /**
   * Create an Order for friend bill splitting with approval link and custom_id reconciliation
   */
  async createFriendSplitOrder(
    friendName: string,
    shareMinor: number,
    currency = 'USD',
    customId = ''
  ): Promise<CreateOrderResult> {
    const value = moneyService.toPayPalValue(shareMinor, currency);

    if (this.isSimulation()) {
      const mockOrderId = `ORD-${Date.now().toString(36).toUpperCase()}`;
      return {
        orderId: mockOrderId,
        payUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${mockOrderId}`,
        status: 'CREATED'
      };
    }

    const token = await this.getAccessToken();
    const payload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: customId,
          custom_id: customId,
          description: `Pocketful Weekend Share for ${friendName}`,
          // Name who gets paid: Pocketful's merchant account. Omitted only when unconfigured (dev/sandbox).
          ...(buildPayee() ? { payee: buildPayee() } : {}),
          amount: {
            currency_code: currency,
            value
          }
        }
      ],
      application_context: {
        brand_name: 'Pocketful',
        user_action: 'PAY_NOW',
        return_url: `${config.APP_BASE_URL}/pay/success`,
        cancel_url: `${config.APP_BASE_URL}/pay/cancel`
      }
    };

    const res = await fetch(`${config.PAYPAL_BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': customId || `req_${Date.now()}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new UpstreamError(`[PayPal] Order creation failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      id: string;
      status: string;
      links: Array<{ rel: string; href: string }>;
    };

    const approveLink = data.links?.find((l) => l.rel === 'approve')?.href ?? '';
    return {
      orderId: data.id,
      payUrl: approveLink,
      status: data.status
    };
  }

  /**
   * Capture authorized PayPal order and verify COMPLETED status
   */
  async captureOrder(orderId: string): Promise<CaptureResult> {
    if (this.isSimulation()) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const mockCaptureId = `CAP-${Date.now().toString(36).toUpperCase()}`;
      return { captureId: mockCaptureId, status: 'COMPLETED' };
    }

    const token = await this.getAccessToken();
    const res = await fetch(`${config.PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `cap_${orderId}`
      }
    });

    if (!res.ok) {
      throw new UpstreamError(`[PayPal] Order capture failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      id: string;
      status: string;
      purchase_units?: Array<{
        payee?: { merchant_id?: string };
        payments?: {
          captures?: Array<{
            id: string;
            status: string;
            amount?: { value: string; currency_code: string };
          }>;
        };
      }>;
    };

    const captureObj = data.purchase_units?.[0]?.payments?.captures?.[0];
    const captureStatus = captureObj?.status ?? data.status;
    const captureId = captureObj?.id ?? data.id;

    if (captureStatus !== 'COMPLETED') {
      throw new UpstreamError(`[PayPal] Capture status not COMPLETED (received: ${captureStatus})`);
    }

    return {
      captureId,
      status: captureStatus,
      amount: captureObj?.amount?.value,
      currency: captureObj?.amount?.currency_code,
      payeeMerchantId: data.purchase_units?.[0]?.payee?.merchant_id
    };
  }

  /**
   * Refund a captured payment
   */
  async refundCapture(captureId: string, note = 'Group outing deadline expired'): Promise<RefundResult> {
    if (this.isSimulation()) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const mockRefundId = `REF-${Date.now().toString(36).toUpperCase()}`;
      return { refundId: mockRefundId, status: 'COMPLETED' };
    }

    const token = await this.getAccessToken();
    const res = await fetch(`${config.PAYPAL_BASE_URL}/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `ref_${captureId}`
      },
      body: JSON.stringify({ note_to_payer: note })
    });

    if (!res.ok) {
      throw new UpstreamError(`[PayPal] Refund failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { id: string; status: string };
    return {
      refundId: data.id,
      status: data.status
    };
  }

  /**
   * Verify Webhook Signature from PayPal
   */
  async verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    rawBody: string
  ): Promise<boolean> {
    if (config.NODE_ENV !== 'production' && this.isSimulation()) {
      return true;
    }

    if (config.NODE_ENV === 'production' && !config.PAYPAL_WEBHOOK_ID) {
      return false;
    }

    try {
      const token = await this.getAccessToken();
      const payload = {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: config.PAYPAL_WEBHOOK_ID,
        webhook_event: JSON.parse(rawBody)
      };

      const res = await fetch(`${config.PAYPAL_BASE_URL}/v1/notification/verify-webhook-signature`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const result = (await res.json()) as { verification_status: string };
        return result.verification_status === 'SUCCESS';
      }
      return false;
    } catch (err) {
      logger.warn('[PayPal] Webhook verification error', { error: String(err) });
      return false;
    }
  }
}

export const paypalService = new PayPalService();
