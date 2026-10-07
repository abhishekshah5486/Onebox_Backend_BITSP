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
    async enqueue(envelope: JobEnvelope<P>): Promise<{ jobId: string; duplicate: boolean }> {
      if (await bull.getJob(envelope.jobId)) {
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

    // Jobs not yet finished; producers use it to slow down when consumers fall behind.
    pending: () => bull.getJobCountByTypes('waiting', 'delayed', 'prioritized', 'active'),

    close: () => bull.close(),
  };
}

export type Producer<P> = ReturnType<typeof createProducer<P>>;
