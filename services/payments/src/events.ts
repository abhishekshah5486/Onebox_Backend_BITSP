import { createJobEnvelope, type PaymentEventPayload } from '@onebox/contracts';
import type { Producer } from '@onebox/queue';
import type { SubscriptionRow } from './db/schema';

export type PaymentEvents = Pick<Producer<PaymentEventPayload>, 'enqueue'>;

// Publishes what happened to a subscription for billing. The job id is the dedupe key: a
// payment confirmed by checkout and again by a webhook becomes one event.
export async function publish(
  events: PaymentEvents,
  type: PaymentEventPayload['type'],
  subscription: Pick<
    SubscriptionRow,
    'id' | 'userId' | 'plan' | 'interval' | 'currentPeriodStart' | 'currentPeriodEnd'
  >,
  { paymentId = null, key }: { paymentId?: string | null; key: string },
) {
  await events.enqueue(
    createJobEnvelope<PaymentEventPayload>({
      jobId: `${type.replace('.', '-')}-${key}`,
      userId: subscription.userId,
      payload: {
        type,
        subscriptionId: subscription.id,
        plan: subscription.plan,
        interval: subscription.interval,
        periodStart: subscription.currentPeriodStart?.toISOString() ?? null,
        periodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        paymentId,
        occurredAt: new Date().toISOString(),
      },
    }),
  );
}
