import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { subscriptions, type SubscriptionRow } from './db/schema';
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

// Copies Stripe's view of a subscription onto ours, adopting its id once checkout made it.
export async function saveStripeSubscription(
  db: PostgresJsDatabase,
  row: SubscriptionRow,
  remote: StripeSubscription,
) {
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
