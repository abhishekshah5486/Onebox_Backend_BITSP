import { createHmac, randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import type { JobEnvelope, PaymentEventPayload } from '@onebox/contracts';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { UnauthorizedError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { createCheckoutService } from './checkout/checkout-service';
import { migratePayments } from './db/migrate';
import { createRazorpay } from './providers/razorpay';
import { createStripe } from './providers/stripe';
import { createRazorpayWebhooks } from './webhooks/razorpay-webhooks';
import { createStripeWebhooks } from './webhooks/stripe-webhooks';

const logger = createLogger({ service: 'test', level: 'silent' });
const KEY_SECRET = 'test-secret';
const WEBHOOK_SECRET = 'hook-secret';
const STRIPE_WEBHOOK_SECRET = 'whsec_test';

const verifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith('user-')) throw new UnauthorizedError('Invalid access token');
  return { userId: token.slice(5), email: `${token.slice(5, 13)}@onebox.dev` };
};

// Stands in for Razorpay's API.
const razorpayCalls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
let nextSubscription = 0;
const razorpayFetch: typeof fetch = async (input, init) => {
  const path = (input as string).replace('https://api.razorpay.com/v1', '');
  const method = init?.method ?? 'GET';
  const body = init?.body
    ? (JSON.parse(init.body as string) as Record<string, unknown>)
    : undefined;
  razorpayCalls.push({ method, path, ...(body && { body }) });
  const json = (value: unknown) => new Response(JSON.stringify(value));
  if (path === '/plans') return json({ id: 'plan_standard_monthly' });
  if (path === '/customers') return json({ id: `cust_${razorpayCalls.length}` });
  if (path === '/subscriptions')
    return json({ id: `sub_${++nextSubscription}`, status: 'created' });
  const subscription = path.match(/^\/subscriptions\/([^/]+)/)?.[1];
  return json({
    id: subscription,
    plan_id: 'plan_standard_monthly',
    status: 'active',
    current_start: 1_791_000_000,
    current_end: 1_793_600_000,
  });
};

// Stands in for Stripe's API. A session stays open until a test completes it.
const stripeCalls: { method: string; path: string; body?: URLSearchParams }[] = [];
const completed = new Set<string>();
const cancelling = new Set<string>();
// Each subscription's current price; new ones start on Standard monthly.
const prices = new Map<string, string>();
let portalSetUp = false;
let nextSession = 0;
const stripeSubscription = (id: string) => ({
  id,
  status: 'active',
  cancel_at_period_end: cancelling.has(id),
  items: {
    data: [
      {
        id: `si_${id}`,
        price: { id: prices.get(id) ?? 'price_standard_monthly' },
        current_period_start: 1_791_000_000,
        current_period_end: 1_793_600_000,
      },
    ],
  },
  latest_invoice: prices.has(id) ? `in_change_${id}` : null,
  metadata: { userId: 'someone' },
});
const stripeFetch: typeof fetch = async (input, init) => {
  const path = (input as string).replace('https://api.stripe.com/v1', '');
  const method = init?.method ?? 'GET';
  const body = init?.body ? new URLSearchParams(init.body as string) : undefined;
  stripeCalls.push({ method, path, ...(body && { body }) });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (path === '/prices') {
    // e.g. price_standard_monthly, from "OneBox Standard" billed every month.
    const plan = body!.get('product_data[name]')!.split(' ')[1]!.toLowerCase();
    const interval = body!.get('recurring[interval]') === 'year' ? 'annual' : 'monthly';
    return json({ id: `price_${plan}_${interval}` });
  }
  if (path === '/customers') return json({ id: `cus_${stripeCalls.length}` });
  if (path === '/checkout/sessions') {
    const id = `cs_${++nextSession}`;
    return json({ id, url: `https://checkout.stripe.com/c/${id}`, status: 'open' });
  }
  if (path === '/billing_portal/configurations') {
    portalSetUp = true;
    return json({ id: 'bpc_1' });
  }
  if (path === '/billing_portal/sessions') {
    return portalSetUp
      ? json({ url: `https://billing.stripe.com/p/${body!.get('customer')}` })
      : json(
          {
            error: {
              message:
                'No configuration provided and your test mode default configuration has not been created.',
            },
          },
          400,
        );
  }
  const session = path.match(/^\/checkout\/sessions\/([^?]+)/)?.[1];
  if (session) {
    const done = completed.has(session);
    return json({
      id: session,
      url: null,
      status: done ? 'complete' : 'open',
      payment_status: done ? 'paid' : 'unpaid',
      subscription: done ? stripeSubscription(`sub_for_${session}`) : null,
      invoice: done ? `in_for_${session}` : null,
    });
  }
  const subscription = path.match(/^\/subscriptions\/([^?]+)/)![1]!;
  if (method === 'POST') {
    const price = body?.get('items[0][price]');
    if (price) prices.set(subscription, price);
    if (body?.get('cancel_at_period_end') === 'true') cancelling.add(subscription);
    else cancelling.delete(subscription);
  }
  return json(stripeSubscription(subscription));
};

const published: JobEnvelope<PaymentEventPayload>[] = [];

let pg: TestPostgres;
let client: PgClient;
let app: HttpServer;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 4 });
  await migratePayments(client, logger);
  const razorpay = createRazorpay(
    { keyId: 'rzp_test_key', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
    logger,
    razorpayFetch,
  );
  const events = {
    enqueue: async (envelope: JobEnvelope<PaymentEventPayload>) => {
      published.push(envelope);
      return { jobId: envelope.jobId, duplicate: false };
    },
  };
  const stripe = createStripe(
    { secretKey: 'sk_test_key', webhookSecret: STRIPE_WEBHOOK_SECRET },
    logger,
    stripeFetch,
  );
  app = buildApp({
    logger,
    pingDatabase: client.ping,
    routes: {
      checkout: createCheckoutService({ db: client.db, razorpay, stripe, events, logger }),
      webhooks: {
        razorpay: createRazorpayWebhooks({ db: client.db, razorpay, events, logger }),
        stripe: createStripeWebhooks({ db: client.db, stripe, events, logger }),
      },
      verifyToken,
    },
  });
});

afterAll(async () => {
  await app.close();
  await client.close();
  await pg.stop();
});

const as = (userId: string) => ({ authorization: `Bearer user-${userId}` });
const sign = (paymentId: string, subscriptionId: string) =>
  createHmac('sha256', KEY_SECRET).update(`${paymentId}|${subscriptionId}`).digest('hex');

describe('checkout', () => {
  const user = randomUUID();

  const start = (who: string, plan = 'STANDARD') =>
    app.inject({
      method: 'POST',
      url: '/payments/checkout',
      headers: as(who),
      payload: { plan, interval: 'monthly' },
    });
  const confirm = (who: string, input: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/payments/checkout/confirm',
      headers: as(who),
      payload: input,
    });

  it('starts a checkout, creating the provider plan only once', async () => {
    const first = await start(user);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      provider: 'RAZORPAY',
      keyId: 'rzp_test_key',
      subscriptionId: 'sub_1',
      amount: 49_900,
      currency: 'INR',
    });
    expect(razorpayCalls.find((c) => c.path === '/subscriptions')?.body).toMatchObject({
      plan_id: 'plan_standard_monthly',
      total_count: 120,
      notes: { userId: user, plan: 'STANDARD', interval: 'monthly' },
    });

    await start(randomUUID());
    expect(razorpayCalls.filter((c) => c.path === '/plans')).toHaveLength(1);
  });

  it('refuses the Free plan and unsigned or foreign confirmations', async () => {
    expect((await start(user, 'FREE')).statusCode).toBe(400);
    const forged = await confirm(user, {
      paymentId: 'pay_1',
      subscriptionId: 'sub_1',
      signature: 'x',
    });
    expect(forged.statusCode).toBe(400);
    const foreign = await confirm(randomUUID(), {
      paymentId: 'pay_1',
      subscriptionId: 'sub_1',
      signature: sign('pay_1', 'sub_1'),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('activates the plan on a signed confirmation and tells billing once per payment', async () => {
    const input = {
      paymentId: 'pay_1',
      subscriptionId: 'sub_1',
      signature: sign('pay_1', 'sub_1'),
    };
    const res = await confirm(user, input);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ plan: 'STANDARD', status: 'active' });
    await confirm(user, input);

    const events = published.filter((e) => e.userId === user);
    expect(events.map((e) => e.jobId)).toEqual(['subscription-activated-pay_1']);
    expect(events[0]!.payload).toMatchObject({
      type: 'subscription.activated',
      plan: 'STANDARD',
      interval: 'monthly',
      paymentId: 'pay_1',
      periodEnd: new Date(1_793_600_000 * 1000).toISOString(),
    });

    const history = await app.inject({ url: '/payments/history', headers: as(user) });
    expect(history.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('allows one paid plan at a time and cancels at the end of the period', async () => {
    const again = await start(user, 'PRO');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'SUBSCRIPTION_EXISTS' } });

    const cancelled = await app.inject({
      method: 'POST',
      url: '/payments/subscription/cancel',
      headers: as(user),
    });
    expect(cancelled.json()).toMatchObject({ cancelAtPeriodEnd: true, status: 'active' });
    expect(razorpayCalls.at(-1)).toMatchObject({
      path: '/subscriptions/sub_1/cancel',
      body: { cancel_at_cycle_end: 1 },
    });

    const current = await app.inject({ url: '/payments/subscription', headers: as(user) });
    expect(current.json()).toMatchObject({ subscription: { plan: 'STANDARD' } });
  });
});

describe('razorpay webhooks', () => {
  const webhook = (body: object, eventId: string, signature?: string) => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': eventId,
        'x-razorpay-signature':
          signature ?? createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
      },
      payload: raw,
    });
  };
  const subscription = (status: string, paidCount: number) => ({
    entity: {
      id: 'sub_1',
      status,
      current_start: 1_793_600_000,
      current_end: 1_796_200_000,
      paid_count: paidCount,
    },
  });

  it('rejects a webhook that is not signed with the webhook secret', async () => {
    const res = await webhook({ event: 'subscription.charged', payload: {} }, 'evt_0', 'forged');
    expect(res.statusCode).toBe(401);
  });

  it('records a renewal once and tells billing, however often it is delivered', async () => {
    const charged = {
      event: 'subscription.charged',
      payload: {
        subscription: subscription('active', 2),
        payment: {
          entity: {
            id: 'pay_2',
            amount: 49_900,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
          },
        },
      },
    };
    expect((await webhook(charged, 'evt_1')).statusCode).toBe(200);
    expect((await webhook(charged, 'evt_1')).statusCode).toBe(200);

    const renewals = published.filter((e) => e.payload.type === 'subscription.renewed');
    expect(renewals.map((e) => e.jobId)).toEqual(['subscription-renewed-pay_2']);
    expect(renewals[0]!.payload).toMatchObject({
      paymentId: 'pay_2',
      periodEnd: new Date(1_796_200_000 * 1000).toISOString(),
    });
  });

  it('passes on a cancellation', async () => {
    const res = await webhook(
      { event: 'subscription.cancelled', payload: { subscription: subscription('cancelled', 2) } },
      'evt_2',
    );
    expect(res.statusCode).toBe(200);
    expect(published.at(-1)!.payload).toMatchObject({ type: 'subscription.cancelled' });
  });
});

describe('stripe', () => {
  const user = randomUUID();
  const start = (who: string) =>
    app.inject({
      method: 'POST',
      url: '/payments/checkout',
      headers: as(who),
      payload: { plan: 'STANDARD', interval: 'monthly', provider: 'STRIPE' },
    });
  const status = (who: string, id: string) =>
    app.inject({ method: 'GET', url: `/payments/checkout/${id}/status`, headers: as(who) });
  const webhook = (body: object, signature?: string) => {
    const raw = JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
    return app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature ?? `t=${t},v1=${v1}`,
      },
      payload: raw,
    });
  };

  it('lists both providers', async () => {
    const res = await app.inject({ method: 'GET', url: '/payments/config', headers: as(user) });
    expect(res.json()).toEqual({ providers: ['RAZORPAY', 'STRIPE'] });
  });

  it('opens a hosted checkout and starts the plan once it is paid', async () => {
    const res = await start(user);
    expect(res.statusCode).toBe(200);
    const { sessionId, url } = res.json<{ sessionId: string; url: string }>();
    expect(url).toBe(`https://checkout.stripe.com/c/${sessionId}`);
    const created = stripeCalls.find((c) => c.path === '/checkout/sessions')!.body!;
    expect(created.get('mode')).toBe('subscription');
    expect(created.get('line_items[0][price]')).toBe('price_standard_monthly');
    expect(created.get('success_url')).toContain('/checkout-return/stripe?result=paid');

    expect((await status(user, sessionId)).json()).toEqual({ state: 'open', subscription: null });
    expect((await status(randomUUID(), sessionId)).statusCode).toBe(404);

    completed.add(sessionId);
    const paid = await status(user, sessionId);
    expect(paid.json()).toMatchObject({
      state: 'paid',
      subscription: { provider: 'STRIPE', plan: 'STANDARD', status: 'active' },
    });
    await status(user, sessionId);
    const activations = published.filter(
      (e) => e.jobId === `subscription-activated-in_for_${sessionId}`,
    );
    expect(activations).toHaveLength(1);

    const history = await app.inject({
      method: 'GET',
      url: '/payments/history',
      headers: as(user),
    });
    expect(history.json<{ items: unknown[] }>().items).toEqual([
      expect.objectContaining({ provider: 'STRIPE', method: 'card', amount: 49_900 }),
    ]);
  });

  it('cancels a Stripe plan at the end of the period', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/payments/subscription/cancel',
      headers: as(user),
    });
    expect(res.json()).toMatchObject({ provider: 'STRIPE', cancelAtPeriodEnd: true });
    expect(stripeCalls.at(-1)!.body!.get('cancel_at_period_end')).toBe('true');
  });

  it('rejects an unsigned webhook', async () => {
    expect((await webhook({ id: 'evt_x', type: 'invoice.paid' }, 't=1,v1=forged')).statusCode).toBe(
      401,
    );
  });

  it('records a renewal invoice once and passes on a deletion', async () => {
    const [session] = [...completed];
    const remoteId = `sub_for_${session}`;
    const invoice = {
      id: 'evt_s1',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_renewal',
          amount_paid: 49_900,
          amount_due: 49_900,
          currency: 'inr',
          billing_reason: 'subscription_cycle',
          parent: { subscription_details: { subscription: remoteId } },
        },
      },
    };
    expect((await webhook(invoice)).statusCode).toBe(200);
    expect((await webhook(invoice)).statusCode).toBe(200);
    expect(published.filter((e) => e.jobId === 'subscription-renewed-in_renewal')).toHaveLength(1);

    const deleted = {
      id: 'evt_s2',
      type: 'customer.subscription.deleted',
      data: { object: { ...stripeSubscription(remoteId), status: 'canceled' } },
    };
    expect((await webhook(deleted)).statusCode).toBe(200);
    expect(published.at(-1)!.payload).toMatchObject({ type: 'subscription.cancelled' });
  });

  it('changes a Stripe plan straight away and tells billing once', async () => {
    const who = randomUUID();
    const { sessionId } = (await start(who)).json<{ sessionId: string }>();
    completed.add(sessionId);
    await status(who, sessionId);

    const change = (plan: string, interval = 'monthly') =>
      app.inject({
        method: 'POST',
        url: '/payments/subscription/change',
        headers: as(who),
        payload: { plan, interval },
      });
    expect((await change('STANDARD')).statusCode).toBe(400);
    const res = await change('PRO');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ plan: 'PRO', interval: 'monthly', status: 'active' });
    const update = stripeCalls.at(-1)!;
    expect(update.path).toBe(`/subscriptions/sub_for_${sessionId}?expand[]=latest_invoice`);
    expect(update.body!.get('items[0][id]')).toBe(`si_sub_for_${sessionId}`);
    expect(update.body!.get('items[0][price]')).toBe('price_pro_monthly');
    expect(update.body!.get('proration_behavior')).toBe('always_invoice');

    // The prorated invoice's webhook names the same plan and dedupes with the change.
    const invoice = `in_change_sub_for_${sessionId}`;
    const paid = {
      id: `evt_${randomUUID()}`,
      type: 'invoice.paid',
      data: {
        object: {
          id: invoice,
          amount_paid: 100_000,
          amount_due: 100_000,
          currency: 'inr',
          billing_reason: 'subscription_update',
          parent: { subscription_details: { subscription: `sub_for_${sessionId}` } },
        },
      },
    };
    expect((await webhook(paid)).statusCode).toBe(200);
    const changes = published.filter((e) => e.jobId === `subscription-changed-${invoice}`);
    expect(changes.map((e) => e.payload.plan)).toEqual(['PRO', 'PRO']);
  });

  it("opens Stripe's billing page, setting it up the first time", async () => {
    const res = await app.inject({ method: 'POST', url: '/payments/portal', headers: as(user) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ url: string }>().url).toMatch(/^https:\/\/billing\.stripe\.com\/p\/cus_/);
    expect(stripeCalls.some((c) => c.path === '/billing_portal/configurations')).toBe(true);
    const noCard = await app.inject({
      method: 'POST',
      url: '/payments/portal',
      headers: as(randomUUID()),
    });
    expect(noCard.statusCode).toBe(404);
  });

  it('shows a return page after checkout', async () => {
    const res = await app.inject({ method: 'GET', url: '/return/stripe?result=paid' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Payment received');
  });
});
