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

const logger = createLogger({ service: 'test', level: 'silent' });
const KEY_SECRET = 'test-secret';

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

const published: JobEnvelope<PaymentEventPayload>[] = [];

let pg: TestPostgres;
let client: PgClient;
let app: HttpServer;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 4 });
  await migratePayments(client, logger);
  app = buildApp({
    logger,
    pingDatabase: client.ping,
    routes: {
      checkout: createCheckoutService({
        db: client.db,
        razorpay: createRazorpay(
          { keyId: 'rzp_test_key', keySecret: KEY_SECRET },
          logger,
          razorpayFetch,
        ),
        events: {
          enqueue: async (envelope) => {
            published.push(envelope);
            return { jobId: envelope.jobId, duplicate: false };
          },
        },
        logger,
      }),
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
    expect(events.map((e) => e.jobId)).toEqual([
      'subscription-activated-pay_1',
      'subscription-activated-pay_1',
    ]);
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
