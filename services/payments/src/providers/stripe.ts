import { createHmac, timingSafeEqual } from 'node:crypto';
import { ExternalServiceError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';

const API = 'https://api.stripe.com/v1';
// How old a webhook's timestamp may be before it is treated as replayed.
const WEBHOOK_TOLERANCE_S = 5 * 60;

// The parts of Stripe's subscription we use. Newer API versions keep the period on the item.
export interface StripeSubscription {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_start?: number;
  current_period_end?: number;
  items?: { data: { current_period_start?: number; current_period_end?: number }[] };
  metadata?: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  subscription: StripeSubscription | string | null;
  invoice: string | { id: string } | null;
}

// Stripe takes form-encoded bodies with nested keys, e.g. recurring[interval]=month.
function form(values: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') form(value as Record<string, unknown>, name, out);
    // Numbers and booleans as Stripe expects them: 10, true.
    else out.append(name, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return out;
}

export const periodOf = (subscription: StripeSubscription) => {
  const item = subscription.items?.data[0];
  const start = subscription.current_period_start ?? item?.current_period_start;
  const end = subscription.current_period_end ?? item?.current_period_end;
  return {
    start: start ? new Date(start * 1000) : null,
    end: end ? new Date(end * 1000) : null,
  };
};

// Stripe's REST API with the account's secret key; only what subscriptions need.
export function createStripe(
  { secretKey, webhookSecret }: { secretKey: string; webhookSecret?: string | undefined },
  logger: Logger,
  send: typeof fetch = fetch,
) {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) {
    const response = await send(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(body && { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(body && { body: form(body).toString() }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { type?: string; code?: string; message?: string };
    };
    if (!response.ok) {
      logger.warn(
        {
          status: response.status,
          path,
          code: payload.error?.code,
          reason: payload.error?.message,
        },
        'stripe request failed',
      );
      throw new ExternalServiceError(
        payload.error?.message ?? 'The payment provider did not accept the request',
      );
    }
    return payload as T;
  }

  return {
    hasWebhookSecret: Boolean(webhookSecret),

    // A recurring price, with its product made alongside.
    async createPrice(input: {
      name: string;
      amount: number;
      currency: string;
      interval: 'month' | 'year';
    }) {
      const price = await call<{ id: string }>('POST', '/prices', {
        currency: input.currency.toLowerCase(),
        unit_amount: input.amount,
        recurring: { interval: input.interval },
        product_data: { name: input.name },
      });
      return price.id;
    },

    async createCustomer(input: { email: string; userId: string }) {
      const customer = await call<{ id: string }>('POST', '/customers', {
        email: input.email,
        metadata: { userId: input.userId },
      });
      return customer.id;
    },

    // Stripe's hosted checkout page for one subscription.
    createCheckoutSession(input: {
      customerId: string;
      priceId: string;
      successUrl: string;
      cancelUrl: string;
      metadata: Record<string, string>;
    }) {
      return call<StripeCheckoutSession>('POST', '/checkout/sessions', {
        mode: 'subscription',
        customer: input.customerId,
        line_items: { 0: { price: input.priceId, quantity: 1 } },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.metadata.userId,
        metadata: input.metadata,
        subscription_data: { metadata: input.metadata },
      });
    },

    retrieveSession: (id: string) =>
      call<StripeCheckoutSession>(
        'GET',
        `/checkout/sessions/${encodeURIComponent(id)}?expand[]=subscription`,
      ),

    retrieveSubscription: (id: string) =>
      call<StripeSubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`),

    // The paid period is kept; Stripe ends the subscription when it runs out.
    cancelAtPeriodEnd: (id: string) =>
      call<StripeSubscription>('POST', `/subscriptions/${encodeURIComponent(id)}`, {
        cancel_at_period_end: true,
      }),

    // Stripe-Signature is "t=<unix>,v1=<hmac of 't.body'>"; old timestamps are refused.
    verifyWebhook(rawBody: string, header: string, now = Date.now()) {
      if (!webhookSecret) return false;
      const parts = new Map<string, string[]>();
      for (const piece of header.split(',')) {
        const [key, value] = piece.split('=');
        if (key && value) parts.set(key, [...(parts.get(key) ?? []), value]);
      }
      const timestamp = Number(parts.get('t')?.[0]);
      if (!timestamp || Math.abs(now / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) return false;
      const expected = Buffer.from(
        createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex'),
      );
      return (parts.get('v1') ?? []).some((signature) => {
        const given = Buffer.from(signature);
        return given.length === expected.length && timingSafeEqual(given, expected);
      });
    },
  };
}

export type Stripe = ReturnType<typeof createStripe>;
