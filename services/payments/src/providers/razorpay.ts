import { createHmac, timingSafeEqual } from 'node:crypto';
import { ExternalServiceError, ServiceUnavailableError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';

const API = 'https://api.razorpay.com/v1';

export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
  webhookSecret?: string | undefined;
}

// The parts of Razorpay's subscription we use. Times are Unix seconds.
export interface RazorpaySubscription {
  id: string;
  plan_id: string;
  status: string;
  current_start: number | null;
  current_end: number | null;
  short_url?: string;
  notes?: Record<string, string>;
}

const hmac = (secret: string, body: string) =>
  createHmac('sha256', secret).update(body).digest('hex');

// Compares in constant time, so the check doesn't leak how much of a signature matched.
const sameSignature = (expected: string, given: string) => {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Razorpay's REST API with the account's key; only what subscriptions need.
export function createRazorpay(
  { keyId, keySecret, webhookSecret }: RazorpayKeys,
  logger: Logger,
  send: typeof fetch = fetch,
) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const response = await send(`${API}${path}`, {
      method,
      headers: {
        authorization: auth,
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; description?: string } | string;
    };
    if (!response.ok) {
      const error = typeof payload.error === 'string' ? null : payload.error;
      // Good keys answered with a bare "Unauthorized": the account can't use this API, i.e.
      // Subscriptions isn't enabled on it.
      if (response.status === 401 && !error) {
        logger.warn({ status: response.status, path }, 'razorpay product not enabled');
        throw new ServiceUnavailableError(
          "Razorpay subscriptions aren't turned on for this account yet. Try another way to pay, or try again later.",
          { code: 'PROVIDER_UNAVAILABLE' },
        );
      }
      // Razorpay's own reason (never the keys), so failures can be told apart in the logs.
      logger.warn(
        { status: response.status, path, code: error?.code, reason: error?.description },
        'razorpay request failed',
      );
      throw new ExternalServiceError(
        error?.description ?? 'The payment provider did not accept the request',
      );
    }
    return payload as T;
  }

  return {
    keyId,
    // Whether webhooks can be checked (a secret is set).
    hasWebhookSecret: Boolean(webhookSecret),

    async createPlan(input: {
      name: string;
      description: string;
      amount: number;
      currency: string;
      period: 'monthly' | 'yearly';
    }) {
      const plan = await call<{ id: string }>('POST', '/plans', {
        period: input.period,
        interval: 1,
        item: {
          name: input.name,
          description: input.description,
          amount: input.amount,
          currency: input.currency,
        },
      });
      return plan.id;
    },

    // Returns the existing customer for this email rather than failing.
    async createCustomer(input: { name: string; email: string }) {
      const customer = await call<{ id: string }>('POST', '/customers', {
        name: input.name,
        email: input.email,
        fail_existing: '0',
      });
      return customer.id;
    },

    createSubscription(input: {
      planId: string;
      customerId: string;
      totalCount: number;
      notes: Record<string, string>;
    }) {
      return call<RazorpaySubscription>('POST', '/subscriptions', {
        plan_id: input.planId,
        customer_id: input.customerId,
        total_count: input.totalCount,
        customer_notify: 1,
        notes: input.notes,
      });
    },

    fetchSubscription: (id: string) =>
      call<RazorpaySubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`),

    // At the cycle end by default, so the paid period is kept.
    cancelSubscription: (id: string, atCycleEnd = true) =>
      call<RazorpaySubscription>('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, {
        cancel_at_cycle_end: atCycleEnd ? 1 : 0,
      }),

    // Checkout returns these three; the signature proves the payment came through Razorpay.
    verifyCheckout(input: { paymentId: string; subscriptionId: string; signature: string }) {
      return sameSignature(
        hmac(keySecret, `${input.paymentId}|${input.subscriptionId}`),
        input.signature,
      );
    },

    // Webhooks are signed over the exact raw body with the webhook secret.
    verifyWebhook(rawBody: string, signature: string) {
      return Boolean(webhookSecret) && sameSignature(hmac(webhookSecret!, rawBody), signature);
    },
  };
}

export type Razorpay = ReturnType<typeof createRazorpay>;
