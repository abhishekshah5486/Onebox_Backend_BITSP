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
import { periodOf, type Stripe, type StripeSubscription } from '../providers/stripe';

const CURRENCY = 'INR';
// How many periods Razorpay keeps billing before the subscription completes.
const TOTAL_COUNT: Record<BillingInterval, number> = { monthly: 120, annual: 10 };
// A subscription that is or may become paid; a user has at most one.
const LIVE_STATUSES = ['authenticated', 'active', 'pending', 'halted'] as const;

export type ProviderName = 'RAZORPAY' | 'STRIPE';
type Status = SubscriptionRow['status'];

// Stripe's subscription states in the terms we store (Razorpay's).
export const stripeStatus = (status: string): Status =>
  (
    ({
      active: 'active',
      trialing: 'active',
      past_due: 'pending',
      unpaid: 'halted',
      paused: 'halted',
      canceled: 'cancelled',
      incomplete: 'created',
      incomplete_expired: 'expired',
    }) as Record<string, Status>
  )[status] ?? 'created';

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
  stripe?: Stripe | null;
  // Used when both are set up and the user doesn't pick.
  defaultProvider?: ProviderName;
  // The gateway's public address, for Stripe's return page.
  publicApiUrl?: string;
  events: PaymentEvents;
  logger: Logger;
}

export function createCheckoutService({
  db,
  razorpay,
  stripe = null,
  defaultProvider = 'RAZORPAY',
  publicApiUrl = 'http://localhost:4000/api/v1',
  events,
  logger,
}: CheckoutDeps) {
  const providers = (): ProviderName[] => [
    ...(razorpay ? (['RAZORPAY'] as const) : []),
    ...(stripe ? (['STRIPE'] as const) : []),
  ];

  const pick = (wanted?: ProviderName): ProviderName => {
    const available = providers();
    if (available.length === 0) throw new ServiceUnavailableError('Payments are not set up yet');
    if (wanted) {
      if (!available.includes(wanted)) {
        throw new ValidationError(`${wanted === 'STRIPE' ? 'Stripe' : 'Razorpay'} is not set up`);
      }
      return wanted;
    }
    return available.includes(defaultProvider) ? defaultProvider : available[0]!;
  };

  // The provider's plan or price for this plan, interval and price, made on first use.
  async function providerPlanId(provider: ProviderName, plan: PlanId, interval: BillingInterval) {
    const amount = periodPrice(plan, interval);
    const match = and(
      eq(providerPlans.provider, provider),
      eq(providerPlans.plan, plan),
      eq(providerPlans.interval, interval),
      eq(providerPlans.amount, amount),
      eq(providerPlans.currency, CURRENCY),
    );
    const [known] = await db.select().from(providerPlans).where(match);
    if (known) return known.providerPlanId;
    const name = `OneBox ${PLAN_CATALOGUE[plan].name}`;
    const id =
      provider === 'STRIPE'
        ? await stripe!.createPrice({
            name,
            amount,
            currency: CURRENCY,
            interval: interval === 'annual' ? 'year' : 'month',
          })
        : await razorpay!.createPlan({
            name,
            description: `${name}, billed ${interval === 'annual' ? 'yearly' : 'monthly'}`,
            amount,
            currency: CURRENCY,
            period: interval === 'annual' ? 'yearly' : 'monthly',
          });
    // Two checkouts at once may both create one; the first stored wins.
    await db
      .insert(providerPlans)
      .values({ provider, plan, interval, amount, currency: CURRENCY, providerPlanId: id })
      .onConflictDoNothing();
    const [stored] = await db.select().from(providerPlans).where(match);
    return stored!.providerPlanId;
  }

  async function customerId(provider: ProviderName, user: CheckoutUser) {
    const mine = and(eq(customers.userId, user.userId), eq(customers.provider, provider));
    const [known] = await db.select().from(customers).where(mine);
    if (known) return known.providerCustomerId;
    const id =
      provider === 'STRIPE'
        ? await stripe!.createCustomer({ email: user.email, userId: user.userId })
        : await razorpay!.createCustomer({ name: user.email, email: user.email });
    await db
      .insert(customers)
      .values({ userId: user.userId, provider, providerCustomerId: id, email: user.email })
      .onConflictDoNothing();
    const [stored] = await db.select().from(customers).where(mine);
    return stored!.providerCustomerId;
  }

  // Copies Razorpay's view of a subscription onto ours.
  async function refreshRazorpay(row: SubscriptionRow, remote: RazorpaySubscription) {
    const [updated] = await db
      .update(subscriptions)
      .set({
        status: remote.status as Status,
        currentPeriodStart: fromUnix(remote.current_start) ?? row.currentPeriodStart,
        currentPeriodEnd: fromUnix(remote.current_end) ?? row.currentPeriodEnd,
      })
      .where(eq(subscriptions.id, row.id))
      .returning();
    return updated!;
  }

  // Copies Stripe's view of a subscription onto ours, adopting its id once checkout made it.
  async function refreshStripe(row: SubscriptionRow, remote: StripeSubscription) {
    const period = periodOf(remote);
    const [updated] = await db
      .update(subscriptions)
      .set({
        providerSubscriptionId: remote.id,
        status: stripeStatus(remote.status),
        currentPeriodStart: period.start ?? row.currentPeriodStart,
        currentPeriodEnd: period.end ?? row.currentPeriodEnd,
        cancelAtPeriodEnd: remote.cancel_at_period_end,
      })
      .where(eq(subscriptions.id, row.id))
      .returning();
    return updated!;
  }

  // Records the first payment and tells billing the plan started (once per payment).
  async function activated(row: SubscriptionRow, providerPaymentId: string) {
    await db
      .insert(payments)
      .values({
        userId: row.userId,
        provider: row.provider,
        providerPaymentId,
        subscriptionId: row.id,
        amount: periodPrice(row.plan, row.interval),
        currency: CURRENCY,
        status: 'captured',
      })
      .onConflictDoNothing();
    await publish(events, 'subscription.activated', row, {
      paymentId: providerPaymentId,
      key: providerPaymentId,
    });
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

  async function startRazorpay(user: CheckoutUser, plan: PlanId, interval: BillingInterval) {
    const remote = await razorpay!.createSubscription({
      planId: await providerPlanId('RAZORPAY', plan, interval),
      customerId: await customerId('RAZORPAY', user),
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
    return {
      provider: 'RAZORPAY' as const,
      keyId: razorpay!.keyId,
      subscriptionId: remote.id,
    };
  }

  async function startStripe(user: CheckoutUser, plan: PlanId, interval: BillingInterval) {
    const returnPage = `${publicApiUrl}/checkout-return/stripe`;
    const session = await stripe!.createCheckoutSession({
      customerId: await customerId('STRIPE', user),
      priceId: await providerPlanId('STRIPE', plan, interval),
      successUrl: `${returnPage}?result=paid`,
      cancelUrl: `${returnPage}?result=cancelled`,
      metadata: { userId: user.userId, plan, interval },
    });
    if (!session.url) throw new ServiceUnavailableError('Stripe did not return a checkout page');
    // Until checkout makes the subscription, the session stands in for its id.
    await db.insert(subscriptions).values({
      userId: user.userId,
      provider: 'STRIPE',
      providerSubscriptionId: session.id,
      checkoutId: session.id,
      plan,
      interval,
      status: 'created',
    });
    return { provider: 'STRIPE' as const, sessionId: session.id, url: session.url };
  }

  return {
    providers,

    // Starts paying for a plan: what the provider's checkout needs to open.
    async start(
      user: CheckoutUser,
      plan: PlanId,
      interval: BillingInterval,
      wanted?: ProviderName,
    ) {
      if (plan === 'FREE') throw new ValidationError('The Free plan needs no payment');
      const provider = pick(wanted);
      if (await liveSubscription(user.userId)) {
        throw new ConflictError('You already have a paid plan. Change or cancel it in Billing.', {
          code: 'SUBSCRIPTION_EXISTS',
        });
      }
      const opened =
        provider === 'STRIPE'
          ? await startStripe(user, plan, interval)
          : await startRazorpay(user, plan, interval);
      logger.info({ userId: user.userId, plan, interval, provider }, 'checkout started');
      return {
        ...opened,
        plan,
        interval,
        amount: periodPrice(plan, interval),
        currency: CURRENCY,
        email: user.email,
      };
    },

    // Razorpay's checkout finished: the signature proves the payment, so the plan starts at once
    // rather than waiting for the webhook (which repeats the same event, deduplicated).
    async confirm(
      userId: string,
      input: { paymentId: string; subscriptionId: string; signature: string },
    ) {
      if (!razorpay) throw new ServiceUnavailableError('Razorpay is not set up');
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
      const updated = await refreshRazorpay(
        row,
        await razorpay.fetchSubscription(row.providerSubscriptionId),
      );
      if (updated.status === 'active' || updated.status === 'authenticated') {
        await activated(updated, input.paymentId);
      }
      logger.info({ userId, status: updated.status }, 'checkout confirmed');
      return subscriptionView(updated);
    },

    // Where a Stripe checkout stands. Paid sessions start the plan here, so it works even
    // before webhooks are set up.
    async checkoutStatus(userId: string, checkoutId: string) {
      if (!stripe) throw new ServiceUnavailableError('Stripe is not set up');
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.checkoutId, checkoutId), eq(subscriptions.userId, userId)));
      if (!row) throw new NotFoundError('That checkout was not found');
      const session = await stripe.retrieveSession(checkoutId);
      if (session.status === 'expired') {
        return { state: 'expired' as const, subscription: null };
      }
      const remote = session.subscription;
      if (session.status !== 'complete' || !remote || typeof remote === 'string') {
        return { state: 'open' as const, subscription: null };
      }
      const updated = await refreshStripe(row, remote);
      const invoice = typeof session.invoice === 'string' ? session.invoice : session.invoice?.id;
      if (updated.status === 'active') await activated(updated, invoice ?? session.id);
      return { state: 'paid' as const, subscription: subscriptionView(updated) };
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
      const refreshed =
        row.provider === 'STRIPE'
          ? await refreshStripe(row, await stripe!.cancelAtPeriodEnd(row.providerSubscriptionId))
          : await refreshRazorpay(
              row,
              await razorpay!.cancelSubscription(row.providerSubscriptionId, true),
            );
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
