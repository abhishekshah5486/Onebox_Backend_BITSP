import type { JobEnvelope, QueueName } from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import { Queue } from 'bullmq';
import { RETRY_POLICIES, type RetryPolicy } from './policies';

export interface ProducerOptions {
  redisUrl: string;
  logger: Logger;
  policy?: RetryPolicy;
}

export function createProducer<P>(queue: QueueName, { redisUrl, logger, policy }: ProducerOptions) {
  const { attempts, backoffMs } = policy ?? RETRY_POLICIES[queue];
  const bull = new Queue(queue, { connection: { url: redisUrl } });

  return {
    // The jobId is deterministic, so enqueuing the same work twice is a no-op; consumers
    // must still be idempotent because finished jobs are eventually removed.
    // retryFailed: a job id that previously failed is replaced instead of being treated as a duplicate.
    async enqueue(
      envelope: JobEnvelope<P>,
      { retryFailed = false }: { retryFailed?: boolean } = {},
    ): Promise<{ jobId: string; duplicate: boolean }> {
      const existing = await bull.getJob(envelope.jobId);
      if (existing && retryFailed && (await existing.isFailed())) {
        await existing.remove();
      } else if (existing) {
        logger.debug({ queue, jobId: envelope.jobId }, 'duplicate job ignored');
        return { jobId: envelope.jobId, duplicate: true };
      }
      await bull.add(queue, envelope, {
        jobId: envelope.jobId,
        attempts,
        backoff: { type: 'exponential', delay: backoffMs },
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      });
      return { jobId: envelope.jobId, duplicate: false };
    },

    // Resolves true once every job has finished (completed, failed, or already removed).
    async waitUntilProcessed(jobIds: string[], { timeoutMs = 120_000, intervalMs = 300 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const states = await Promise.all(jobIds.map((id) => bull.getJobState(id)));
        if (states.every((state) => ['completed', 'failed', 'unknown'].includes(state)))
          return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },

    // Jobs not yet finished; producers use it to slow down when consumers fall behind.
    pending: () => bull.getJobCountByTypes('waiting', 'delayed', 'prioritized', 'active'),

    close: () => bull.close(),
  };
}

export type Producer<P> = ReturnType<typeof createProducer<P>>;
