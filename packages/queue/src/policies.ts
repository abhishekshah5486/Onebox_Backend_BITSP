import type { QueueName } from '@onebox/contracts';

export interface RetryPolicy {
  attempts: number;
  backoffMs: number;
}

// Per-queue retry budgets from the architecture spec (5.1.3); backoff is exponential.
export const RETRY_POLICIES: Record<QueueName, RetryPolicy> = {
  ingest: { attempts: 5, backoffMs: 2_000 },
  ai: { attempts: 3, backoffMs: 5_000 },
  index: { attempts: 5, backoffMs: 1_000 },
  embed: { attempts: 3, backoffMs: 5_000 },
  rules: { attempts: 3, backoffMs: 2_000 },
  action: { attempts: 4, backoffMs: 10_000 },
};

export const deadLetterQueue = (queue: QueueName) => `${queue}-dlq`;
