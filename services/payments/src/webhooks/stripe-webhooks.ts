import { UnauthorizedError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { payments, subscriptions, webhookEvents, type SubscriptionRow } from '../db/schema';
import { publish, type PaymentEvents } from '../events';
import type { Stripe, StripeSubscription } from '../providers/stripe';
import { saveStripeSubscription } from '../stripe-sync';

interface StripeInvoice {
  id: string;
  amount_paid: number;
  amount_due: number;
  currency: string;
  billing_reason: string | null;
  // Older API versions put the subscription here, newer ones under parent.
  subscription?: string | null;
  parent?: { subscription_details?: { subscription?: string } | null } | null;
  last_finalization_error?: { message?: string } | null;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const invoiceSubscription = (invoice: StripeInvoice) =>
  invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null;

// Stripe's webhooks: checked by signature, stored once by event id, and turned into
// subscription updates and events for billing.
export function createStripeWebhooks({
  db,
  stripe,
  events,
  logger,
}: {
  db: PostgresJsDatabase;
  stripe: Stripe;
  events: PaymentEvents;
  logger: Logger;
}) {
  const bySubscription = (id: string) =>
    db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, id))
      .then((rows) => rows[0]);

  // Our row for a Stripe subscription. Until checkout finishes, it is known by the session
  // instead; an invoice can arrive before that, so Stripe is asked to retry.
  async function rowFor(id: string, ours: boolean) {
    const row = await bySubscription(id);
    if (!row && ours) throw new Error('Subscription not linked to its checkout yet');
    return row;
  }

  async function recordPayment(
    sub: SubscriptionRow,
    invoice: StripeInvoice,
    status: 'captured' | 'failed',
  ) {
    await db
      .insert(payments)
      .values({
        userId: sub.userId,
        provider: 'STRIPE',
        providerPaymentId: invoice.id,
        subscriptionId: sub.id,
        amount: status === 'captured' ? invoice.amount_paid : invoice.amount_due,
        currency: invoice.currency.toUpperCase(),
        status,
        method: 'card',
        failureReason:
          status === 'failed'
            ? (invoice.last_finalization_error?.message ?? 'Payment failed')
            : null,
      })
      .onConflictDoUpdate({ target: payments.providerPaymentId, set: { status } });
  }

  async function apply(event: StripeEvent) {
    const object = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        const [row] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.checkoutId, object.id as string));
        if (!row || typeof object.subscription !== 'string') return;
        await saveStripeSubscription(
          db,
          row,
          await stripe.retrieveSubscription(object.subscription),
        );
        return;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = object as unknown as StripeInvoice;
        const remoteId = invoiceSubscription(invoice);
        if (!remoteId) return;
        const remote = await stripe.retrieveSubscription(remoteId);
        const row = await rowFor(remoteId, Boolean(remote.metadata?.userId));
        if (!row) return;
        const sub = await saveStripeSubscription(db, row, remote);
        if (event.type === 'invoice.payment_failed') {
          await recordPayment(sub, invoice, 'failed');
          await publish(events, 'payment.failed', sub, { paymentId: invoice.id, key: invoice.id });
          return;
        }
        await recordPayment(sub, invoice, 'captured');
        // The first invoice starts the plan (the status check may already have said so, same
        // key); each later one renews it.
        await publish(
          events,
          invoice.billing_reason === 'subscription_create'
            ? 'subscription.activated'
            : 'subscription.renewed',
          sub,
          { paymentId: invoice.id, key: invoice.id },
        );
        return;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const remote = object as unknown as StripeSubscription;
        const row = await bySubscription(remote.id);
        if (!row) return;
        const sub = await saveStripeSubscription(db, row, remote);
        if (sub.status === 'cancelled') {
          await publish(events, 'subscription.cancelled', sub, { key: sub.id });
        } else if (sub.status === 'halted' && row.status !== 'halted') {
          await publish(events, 'subscription.halted', sub, {
            key: `${sub.id}-${sub.currentPeriodEnd?.getTime() ?? 'now'}`,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  return {
    // Records and applies one webhook; a repeat of a finished event does nothing.
    async receive(rawBody: string, signature: string | undefined) {
      if (!signature || !stripe.verifyWebhook(rawBody, signature)) {
        throw new UnauthorizedError('Invalid webhook signature');
      }
      const event = JSON.parse(rawBody) as StripeEvent;
      await db
        .insert(webhookEvents)
        .values({ provider: 'STRIPE', eventId: event.id, type: event.type, payload: event })
        .onConflictDoNothing();
      const pending = and(
        eq(webhookEvents.provider, 'STRIPE'),
        eq(webhookEvents.eventId, event.id),
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
        // Kept unprocessed, so Stripe's retry runs it again.
        await db
          .update(webhookEvents)
          .set({ error: (err as Error).message })
          .where(eq(webhookEvents.id, stored.id));
        throw err;
      }
      logger.info({ event: event.type }, 'stripe webhook applied');
      return { duplicate: false };
    },
  };
}

export type StripeWebhooks = ReturnType<typeof createStripeWebhooks>;
