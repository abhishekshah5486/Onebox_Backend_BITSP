import { PLAN_CATALOGUE, periodPrice, type BillingInterval, type PlanId } from '@onebox/contracts';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  customers,
  payments,
  providerPlans,
  subscriptions,
  type SubscriptionRow,
} from '../db/schema';
import { publish, type PaymentEvents } from '../events';
import type { Razorpay, RazorpaySubscription } from '../providers/razorpay';

const CURRENCY = 'INR';
// How many periods Razorpay keeps billing before the subscription completes.
const TOTAL_COUNT: Record<BillingInterval, number> = { monthly: 120, annual: 10 };
// A subscription that is or may become paid; a user has at most one.
const LIVE_STATUSES = ['authenticated', 'active', 'pending', 'halted'] as const;

export interface CheckoutUser {
  userId: string;
  email: string;
}

const fromUnix = (seconds: number | null) => (seconds ? new Date(seconds * 1000) : null);

export const subscriptionView = (row: SubscriptionRow) => ({
  id: row.id,
  provider: row.provider,
  plan: row.plan,
  interval: row.interval,
  status: row.status,
  currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
  currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
  cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  createdAt: row.createdAt.toISOString(),
});

export interface CheckoutDeps {
  db: PostgresJsDatabase;
  razorpay: Razorpay | null;
  events: PaymentEvents;
  logger: Logger;
}

export function createCheckoutService({ db, razorpay, events, logger }: CheckoutDeps) {
  const provider = () => {
    if (!razorpay) throw new ServiceUnavailableError('Payments are not set up yet');
    return razorpay;
  };

  // The Razorpay plan for this plan, interval and price, created the first time it is needed.
  async function providerPlanId(plan: PlanId, interval: BillingInterval) {
    const amount = periodPrice(plan, interval);
    const match = and(
      eq(providerPlans.provider, 'RAZORPAY'),
      eq(providerPlans.plan, plan),
      eq(providerPlans.interval, interval),
      eq(providerPlans.amount, amount),
      eq(providerPlans.currency, CURRENCY),
    );
    const [known] = await db.select().from(providerPlans).where(match);
    if (known) return known.providerPlanId;
    const name = PLAN_CATALOGUE[plan].name;
    const id = await provider().createPlan({
      name: `OneBox ${name}`,
      description: `OneBox ${name}, billed ${interval === 'annual' ? 'yearly' : 'monthly'}`,
      amount,
      currency: CURRENCY,
      period: interval === 'annual' ? 'yearly' : 'monthly',
    });
    // Two checkouts at once may both create one; the first stored wins.
    await db
      .insert(providerPlans)
      .values({
        provider: 'RAZORPAY',
        plan,
        interval,
        amount,
        currency: CURRENCY,
        providerPlanId: id,
      })
      .onConflictDoNothing();
    const [stored] = await db.select().from(providerPlans).where(match);
    return stored!.providerPlanId;
  }

  async function customerId(user: CheckoutUser) {
    const mine = and(eq(customers.userId, user.userId), eq(customers.provider, 'RAZORPAY'));
    const [known] = await db.select().from(customers).where(mine);
    if (known) return known.providerCustomerId;
    const id = await provider().createCustomer({ name: user.email, email: user.email });
    await db
      .insert(customers)
      .values({
        userId: user.userId,
        provider: 'RAZORPAY',
        providerCustomerId: id,
        email: user.email,
      })
      .onConflictDoNothing();
    const [stored] = await db.select().from(customers).where(mine);
    return stored!.providerCustomerId;
  }

  // Copies Razorpay's view of a subscription onto ours.
  async function refresh(row: SubscriptionRow, remote: RazorpaySubscription) {
    const [updated] = await db
      .update(subscriptions)
      .set({
        status: remote.status as SubscriptionRow['status'],
        currentPeriodStart: fromUnix(remote.current_start) ?? row.currentPeriodStart,
        currentPeriodEnd: fromUnix(remote.current_end) ?? row.currentPeriodEnd,
      })
      .where(eq(subscriptions.id, row.id))
      .returning();
    return updated!;
  }

  const liveSubscription = (userId: string) =>
    db
      .select()
      .from(subscriptions)
      .where(
        and(eq(subscriptions.userId, userId), inArray(subscriptions.status, [...LIVE_STATUSES])),
      )
      .orderBy(desc(subscriptions.createdAt))
      .then((rows) => rows[0]);

  return {
    configured: () => razorpay !== null,

    // Starts paying for a plan: what Razorpay's checkout needs to open.
    async start(user: CheckoutUser, plan: PlanId, interval: BillingInterval) {
      if (plan === 'FREE') throw new ValidationError('The Free plan needs no payment');
      const razorpay = provider();
      if (await liveSubscription(user.userId)) {
        throw new ConflictError('You already have a paid plan. Change or cancel it in Billing.', {
          code: 'SUBSCRIPTION_EXISTS',
        });
      }
      const remote = await razorpay.createSubscription({
        planId: await providerPlanId(plan, interval),
        customerId: await customerId(user),
        totalCount: TOTAL_COUNT[interval],
        notes: { userId: user.userId, plan, interval },
      });
      await db.insert(subscriptions).values({
        userId: user.userId,
        provider: 'RAZORPAY',
        providerSubscriptionId: remote.id,
        plan,
        interval,
        status: 'created',
      });
      logger.info({ userId: user.userId, plan, interval }, 'checkout started');
      return {
        provider: 'RAZORPAY' as const,
        keyId: razorpay.keyId,
        subscriptionId: remote.id,
        plan,
        interval,
        amount: periodPrice(plan, interval),
        currency: CURRENCY,
        email: user.email,
      };
    },

    // Checkout finished: the signature proves the payment, then the plan starts at once rather
    // than waiting for the webhook (which repeats the same event, deduplicated).
    async confirm(
      userId: string,
      input: { paymentId: string; subscriptionId: string; signature: string },
    ) {
      const razorpay = provider();
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.providerSubscriptionId, input.subscriptionId),
            eq(subscriptions.userId, userId),
          ),
        );
      if (!row) throw new NotFoundError('That subscription was not found');
      if (!razorpay.verifyCheckout(input)) {
        throw new ValidationError('The payment could not be verified');
      }
      const updated = await refresh(
        row,
        await razorpay.fetchSubscription(row.providerSubscriptionId),
      );
      await db
        .insert(payments)
        .values({
          userId,
          provider: 'RAZORPAY',
          providerPaymentId: input.paymentId,
          subscriptionId: row.id,
          amount: periodPrice(row.plan, row.interval),
          currency: CURRENCY,
          status: 'captured',
        })
        .onConflictDoNothing();
      if (updated.status === 'active' || updated.status === 'authenticated') {
        await publish(events, 'subscription.activated', updated, {
          paymentId: input.paymentId,
          key: input.paymentId,
        });
      }
      logger.info({ userId, status: updated.status }, 'checkout confirmed');
      return subscriptionView(updated);
    },

    async current(userId: string) {
      const row = await liveSubscription(userId);
      return row ? subscriptionView(row) : null;
    },

    // Stops renewing; the plan lasts until the end of the paid period.
    async cancel(userId: string) {
      const row = await liveSubscription(userId);
      if (!row) throw new NotFoundError('You have no paid plan to cancel');
      if (row.cancelAtPeriodEnd) return subscriptionView(row);
      const remote = await provider().cancelSubscription(row.providerSubscriptionId, true);
      const refreshed = await refresh(row, remote);
      const [updated] = await db
        .update(subscriptions)
        .set({ cancelAtPeriodEnd: true })
        .where(eq(subscriptions.id, refreshed.id))
        .returning();
      logger.info({ userId }, 'subscription set to cancel at period end');
      return subscriptionView(updated!);
    },

    async history(userId: string) {
      const rows = await db
        .select()
        .from(payments)
        .where(eq(payments.userId, userId))
        .orderBy(desc(payments.createdAt))
        .limit(100);
      return rows.map((row) => ({
        id: row.id,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        method: row.method,
        failureReason: row.failureReason,
        createdAt: row.createdAt.toISOString(),
      }));
    },
  };
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;
