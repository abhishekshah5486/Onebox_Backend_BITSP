import { randomUUID } from 'node:crypto';
import { INTERNAL_TOKEN_HEADER, type TokenVerifier } from '@onebox/auth-kit';
import type { PaymentEventPayload } from '@onebox/contracts';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { UnauthorizedError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { createCredits, type Credits } from './credits/credits';
import { migrateBilling } from './db/migrate';

const logger = createLogger({ service: 'test', level: 'silent' });
const INTERNAL = 'internal-token';

const verifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith('user-')) throw new UnauthorizedError('Invalid access token');
  return { userId: token.slice(5), email: 'a@onebox.dev' };
};

let pg: TestPostgres;
let client: PgClient;
let credits: Credits;
let app: HttpServer;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 4 });
  await migrateBilling(client, logger);
  credits = createCredits({ db: client.db, creditsPerUsd: 170, logger });
  app = buildApp({
    logger,
    pingDatabase: client.ping,
    routes: { credits, verifyToken, internalToken: INTERNAL },
  });
});

afterAll(async () => {
  await app.close();
  await client.close();
  await pg.stop();
});

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const event = (
  type: PaymentEventPayload['type'],
  overrides: Partial<PaymentEventPayload> = {},
): PaymentEventPayload => ({
  type,
  subscriptionId: randomUUID(),
  plan: 'STANDARD',
  interval: 'monthly',
  periodStart: new Date().toISOString(),
  periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  paymentId: `pay_${randomUUID()}`,
  occurredAt: new Date().toISOString(),
  ...overrides,
});
const usage = (costUsd: number, callId = randomUUID()) => ({
  callId,
  purpose: 'classify',
  model: 'gpt-x',
  modelName: 'GPT X',
  costUsd,
  occurredAt: new Date().toISOString(),
});

describe('credits', () => {
  it('starts a new user on Free with its credits', async () => {
    const user = randomUUID();
    const overview = await credits.overview(user);
    expect(overview).toMatchObject({
      subscription: { plan: 'FREE', interval: null, status: 'free', renewsAt: null },
      balance: 20,
      periodCredits: 20,
    });
    expect(overview.ledger).toEqual([
      expect.objectContaining({ kind: 'grant', credits: 20, description: 'Free plan credits' }),
    ]);
  });

  it('starts a paid plan once per payment, with the first-month bonus', async () => {
    const user = randomUUID();
    const activated = event('subscription.activated');
    await credits.applyPayment('job-1', user, activated);
    await credits.applyPayment('job-1', user, activated);
    // The same payment under another job id still counts once.
    await credits.applyPayment(`job-${randomUUID()}`, user, activated);

    const overview = await credits.overview(user);
    expect(overview).toMatchObject({
      subscription: { plan: 'STANDARD', interval: 'monthly', status: 'active' },
      balance: 750,
      periodCredits: 750,
    });
    expect(overview.ledger.map((line) => [line.kind, line.credits])).toEqual([
      ['grant', 250],
      ['grant', 500],
      ['expiry', -20],
      ['grant', 20],
    ]);
  });

  it('charges each call once, in fractions of a credit, and stops at zero', async () => {
    const user = randomUUID();
    const call = usage(0.002);
    await credits.charge(user, call);
    await credits.charge(user, call);
    // Tiny calls still use the smallest step.
    await credits.charge(user, usage(0.000001));
    // $0.002 × ₹85 × 2 = 0.34 credits, then the smallest step.
    expect((await credits.allowance(user)).balance).toBe(19.659);
    // A real sort: $0.00022 is 0.0374 credits, rounded up so it stays at least twice the cost.
    await credits.charge(user, usage(0.00022));
    expect((await credits.allowance(user)).balance).toBe(19.621);

    await credits.charge(user, usage(1));
    expect(await credits.allowance(user)).toEqual({ allowed: false, balance: -150.379 });
    const [latest] = (await credits.overview(user)).ledger;
    expect(latest).toMatchObject({
      kind: 'charge',
      description: 'Sorted an email into labels',
      model: 'GPT X',
      modelId: 'gpt-x',
    });
  });

  it('renews with a fresh month and no second bonus', async () => {
    const user = randomUUID();
    const subscriptionId = randomUUID();
    await credits.applyPayment(
      randomUUID(),
      user,
      event('subscription.activated', { subscriptionId }),
    );
    await credits.charge(user, usage(0.5));
    await credits.applyPayment(
      randomUUID(),
      user,
      event('subscription.renewed', { subscriptionId }),
    );

    const overview = await credits.overview(user);
    expect(overview.balance).toBe(500);
    expect(overview.ledger.filter((line) => line.credits === 250)).toHaveLength(1);
    expect(overview.ledger[1]).toMatchObject({ kind: 'expiry', credits: -665 });
  });

  it('refills annual plans monthly within the paid year', async () => {
    const user = randomUUID();
    await credits.applyPayment(
      randomUUID(),
      user,
      event('subscription.activated', {
        plan: 'PRO',
        interval: 'annual',
        periodStart: daysAgo(40).toISOString(),
        periodEnd: new Date(Date.now() + 325 * 86_400_000).toISOString(),
      }),
    );
    await credits.charge(user, usage(2));
    expect(await credits.refillDue()).toBeGreaterThanOrEqual(1);
    await credits.refillDue();

    const overview = await credits.overview(user);
    expect(overview.balance).toBe(2_000);
    expect(
      overview.ledger.filter((line) => line.kind === 'grant' && line.credits === 2_000),
    ).toHaveLength(2);
    expect(new Date(overview.subscription.renewsAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('moves to another plan mid-period with its credits', async () => {
    const user = randomUUID();
    const subscriptionId = randomUUID();
    await credits.applyPayment(
      randomUUID(),
      user,
      event('subscription.activated', { subscriptionId }),
    );
    await credits.applyPayment(
      randomUUID(),
      user,
      event('subscription.changed', { subscriptionId, plan: 'PRO' }),
    );
    expect(await credits.overview(user)).toMatchObject({
      subscription: { plan: 'PRO', status: 'active' },
      balance: 2_000,
      periodCredits: 2_000,
    });
  });

  it('pauses AI when payments fail, and ends the plan on cancellation', async () => {
    const user = randomUUID();
    const subscriptionId = randomUUID();
    await credits.applyPayment(
      randomUUID(),
      user,
      event('subscription.activated', { subscriptionId }),
    );
    await credits.applyPayment(randomUUID(), user, event('payment.failed', { subscriptionId }));
    expect((await credits.overview(user)).subscription.status).toBe('past_due');
    expect((await credits.allowance(user)).allowed).toBe(true);

    await credits.applyPayment(
      randomUUID(),
      user,
      event('subscription.halted', { subscriptionId }),
    );
    expect((await credits.allowance(user)).allowed).toBe(false);

    // A cancellation of some older subscription leaves the current one alone.
    await credits.applyPayment(randomUUID(), user, event('subscription.cancelled'));
    expect((await credits.overview(user)).subscription.plan).toBe('STANDARD');

    await credits.applyPayment(
      randomUUID(),
      user,
      event('subscription.cancelled', { subscriptionId }),
    );
    expect(await credits.overview(user)).toMatchObject({
      subscription: { plan: 'FREE', status: 'free', renewsAt: null },
      balance: 0,
    });
  });
});

describe('routes', () => {
  it('shows the signed-in user their billing', async () => {
    const user = randomUUID();
    expect((await app.inject({ url: '/billing' })).statusCode).toBe(401);
    const res = await app.inject({
      url: '/billing',
      headers: { authorization: `Bearer user-${user}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ balance: 20, subscription: { plan: 'FREE' } });
  });

  it('answers allowance only to other services', async () => {
    const url = `/internal/billing/allowance/${randomUUID()}`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const res = await app.inject({ url, headers: { [INTERNAL_TOKEN_HEADER]: INTERNAL } });
    expect(res.json()).toEqual({ allowed: true, balance: 20 });
  });
});
