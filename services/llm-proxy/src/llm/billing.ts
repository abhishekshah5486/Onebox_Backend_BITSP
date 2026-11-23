import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { createJobEnvelope, type UsageEventPayload } from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import type { Producer } from '@onebox/queue';

export interface Billing {
  // Whether the user has credits left for a model call.
  allowed(userId: string): Promise<boolean>;
  // Reports a call that cost money; billing charges it once.
  charge(userId: string, call: Omit<UsageEventPayload, 'occurredAt'>): Promise<void>;
}

export function createBillingClient({
  baseUrl,
  internalToken,
  usage,
  logger,
}: {
  baseUrl: string;
  internalToken: string;
  usage: Pick<Producer<UsageEventPayload>, 'enqueue'>;
  logger: Logger;
}): Billing {
  return {
    async allowed(userId) {
      try {
        const response = await fetch(new URL(`/internal/billing/allowance/${userId}`, baseUrl), {
          headers: { [INTERNAL_TOKEN_HEADER]: internalToken },
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return ((await response.json()) as { allowed: boolean }).allowed;
      } catch (err) {
        // Billing being down shouldn't stop mail features; the call is still charged later.
        logger.warn({ err: (err as Error).message }, 'could not check credits, allowing the call');
        return true;
      }
    },
    async charge(userId, call) {
      await usage.enqueue(
        createJobEnvelope<UsageEventPayload>({
          jobId: `usage-${call.callId}`,
          userId,
          payload: { ...call, occurredAt: new Date().toISOString() },
        }),
      );
    },
  };
}
