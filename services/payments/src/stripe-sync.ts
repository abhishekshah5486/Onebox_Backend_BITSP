import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { providerPlans, subscriptions, type SubscriptionRow } from './db/schema';
import { periodOf, type StripeSubscription } from './providers/stripe';

type Status = SubscriptionRow['status'];

const STATUSES: Record<string, Status> = {
  active: 'active',
  trialing: 'active',
  past_due: 'pending',
  unpaid: 'halted',
  paused: 'halted',
  canceled: 'cancelled',
  incomplete: 'created',
  incomplete_expired: 'expired',
};

// Stripe's subscription states in the terms we store (Razorpay's).
export const stripeStatus = (status: string): Status => STATUSES[status] ?? 'created';

// Copies Stripe's view of a subscription onto ours, adopting its id once checkout made it. The
// plan comes from its price, so a change seen first by a webhook still names the new plan.
export async function saveStripeSubscription(
  db: PostgresJsDatabase,
  row: SubscriptionRow,
  remote: StripeSubscription,
) {
  const period = periodOf(remote);
  const priceId = remote.items?.data[0]?.price?.id;
  const [price] = priceId
    ? await db
        .select({ plan: providerPlans.plan, interval: providerPlans.interval })
        .from(providerPlans)
        .where(and(eq(providerPlans.provider, 'STRIPE'), eq(providerPlans.providerPlanId, priceId)))
    : [];
  const [updated] = await db
    .update(subscriptions)
    .set({
      providerSubscriptionId: remote.id,
      status: stripeStatus(remote.status),
      currentPeriodStart: period.start ?? row.currentPeriodStart,
      currentPeriodEnd: period.end ?? row.currentPeriodEnd,
      cancelAtPeriodEnd: remote.cancel_at_period_end,
      ...price,
    })
    .where(eq(subscriptions.id, row.id))
    .returning();
  return updated!;
}
