import { periodPrice } from '@onebox/contracts';
import { UnauthorizedError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { payments, subscriptions, webhookEvents, type SubscriptionRow } from '../db/schema';
import { publish, type PaymentEvents } from '../events';
import type { Razorpay } from '../providers/razorpay';

interface Entity<T> {
  entity: T;
}

interface RazorpayEvent {
  event: string;
  payload: {
    subscription?: Entity<{
      id: string;
      status: string;
      current_start: number | null;
      current_end: number | null;
      paid_count?: number;
    }>;
    payment?: Entity<{
      id: string;
      amount: number;
      currency: string;
      status: string;
      method?: string;
      error_description?: string | null;
    }>;
  };
}

const fromUnix = (seconds: number | null | undefined) =>
  seconds ? new Date(seconds * 1000) : null;

// Razorpay's webhooks: checked by signature, stored once by event id, and turned into
// subscription updates and events for billing.
export function createRazorpayWebhooks({
  db,
  razorpay,
  events,
  logger,
}: {
  db: PostgresJsDatabase;
  razorpay: Razorpay;
  events: PaymentEvents;
  logger: Logger;
}) {
  async function apply(event: RazorpayEvent) {
    const remote = event.payload.subscription?.entity;
    if (!remote) return;
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, remote.id));
    // Made outside OneBox (e.g. in the dashboard): nothing of ours to update.
    if (!row) {
      logger.warn({ event: event.event }, 'webhook for an unknown subscription');
      return;
    }
    const [sub] = (await db
      .update(subscriptions)
      .set({
        status: remote.status as SubscriptionRow['status'],
        currentPeriodStart: fromUnix(remote.current_start) ?? row.currentPeriodStart,
        currentPeriodEnd: fromUnix(remote.current_end) ?? row.currentPeriodEnd,
      })
      .where(eq(subscriptions.id, row.id))
      .returning()) as [SubscriptionRow];

    const payment = event.payload.payment?.entity;
    if (payment) {
      await db
        .insert(payments)
        .values({
          userId: sub.userId,
          provider: 'RAZORPAY',
          providerPaymentId: payment.id,
          subscriptionId: sub.id,
          amount: payment.amount ?? periodPrice(sub.plan, sub.interval),
          currency: payment.currency ?? 'INR',
          status: payment.status === 'failed' ? 'failed' : 'captured',
          method: payment.method ?? null,
          failureReason: payment.error_description ?? null,
        })
        .onConflictDoUpdate({
          target: payments.providerPaymentId,
          set: { method: payment.method ?? null },
        });
    }

    switch (event.event) {
      case 'subscription.charged':
        // The first charge starts the plan (checkout may already have said so, same key);
        // each later one renews it.
        if (payment) {
          await publish(
            events,
            remote.paid_count === 1 ? 'subscription.activated' : 'subscription.renewed',
            sub,
            { paymentId: payment.id, key: payment.id },
          );
        }
        break;
      case 'subscription.halted':
        await publish(events, 'subscription.halted', sub, {
          key: `${sub.id}-${remote.current_end ?? 'now'}`,
        });
        break;
      case 'subscription.cancelled':
      case 'subscription.completed':
        await publish(events, 'subscription.cancelled', sub, { key: sub.id });
        break;
      case 'subscription.pending':
        if (payment?.status === 'failed') {
          await publish(events, 'payment.failed', sub, { paymentId: payment.id, key: payment.id });
        }
        break;
      default:
        break;
    }
  }

  return {
    // Records and applies one webhook; a repeat of a finished event does nothing.
    async receive(rawBody: string, signature: string | undefined, eventId: string | undefined) {
      if (!signature || !razorpay.verifyWebhook(rawBody, signature)) {
        throw new UnauthorizedError('Invalid webhook signature');
      }
      const event = JSON.parse(rawBody) as RazorpayEvent;
      const id = eventId ?? `${event.event}-${Date.now()}`;
      await db
        .insert(webhookEvents)
        .values({ provider: 'RAZORPAY', eventId: id, type: event.event, payload: event })
        .onConflictDoNothing();
      const pending = and(
        eq(webhookEvents.provider, 'RAZORPAY'),
        eq(webhookEvents.eventId, id),
        isNull(webhookEvents.processedAt),
      );
      const [stored] = await db.select().from(webhookEvents).where(pending);
      if (!stored) return { duplicate: true };
      try {
        await apply(event);
        await db
          .update(webhookEvents)
          .set({ processedAt: new Date(), error: null })
          .where(eq(webhookEvents.id, stored.id));
      } catch (err) {
        // Kept unprocessed, so Razorpay's retry runs it again.
        await db
          .update(webhookEvents)
          .set({ error: (err as Error).message })
          .where(eq(webhookEvents.id, stored.id));
        throw err;
      }
      logger.info({ event: event.event }, 'razorpay webhook applied');
      return { duplicate: false };
    },
  };
}

export type RazorpayWebhooks = ReturnType<typeof createRazorpayWebhooks>;
