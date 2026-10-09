import { isAppError } from '@onebox/errors';
import { jobEnvelopeSchema, type JobEnvelope, type QueueName } from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import type { z } from 'zod';
import { deadLetterQueue } from './policies';

export interface JobContext {
  logger: Logger;
  attempt: number;
}

export interface ConsumerOptions {
  redisUrl: string;
  logger: Logger;
  concurrency?: number;
}

export function createConsumer<S extends z.ZodType>(
  queue: QueueName,
  payloadSchema: S,
  handler: (envelope: JobEnvelope<z.infer<S>>, context: JobContext) => Promise<void>,
  { redisUrl, logger, concurrency = 5 }: ConsumerOptions,
) {
  const envelopeSchema = jobEnvelopeSchema(payloadSchema);
  const dlq = new Queue(deadLetterQueue(queue), { connection: { url: redisUrl } });

  const worker = new Worker(
    queue,
    async (job: Job) => {
      const parsed = envelopeSchema.safeParse(job.data);
      if (!parsed.success) {
        // A malformed job will never succeed; skip retries and go straight to the DLQ.
        throw new UnrecoverableError(`Invalid job envelope: ${parsed.error.issues[0]?.message}`);
      }
      const envelope = parsed.data as JobEnvelope<z.infer<S>>;
      const jobLogger = logger.child({
        queue,
        jobId: envelope.jobId,
        traceId: envelope.traceId,
        attempt: job.attemptsMade + 1,
      });
      try {
        await handler(envelope, { logger: jobLogger, attempt: job.attemptsMade + 1 });
      } catch (err) {
        if (isAppError(err) && !err.retryable) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    { connection: { url: redisUrl }, concurrency },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const exhausted =
      err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) {
      logger.warn(
        { queue, jobId: job.id, attempt: job.attemptsMade, err },
        'job failed, will retry',
      );
      return;
    }
    void dlq
      .add(
        'dead',
        {
          queue,
          jobId: job.id,
          data: job.data as unknown,
          error: err.message,
          attemptsMade: job.attemptsMade,
          failedAt: new Date().toISOString(),
        },
        { jobId: job.id },
      )
      .then(() =>
        logger.error(
          { queue, jobId: job.id, attempts: job.attemptsMade, err },
          'job moved to dead letter queue',
        ),
      )
      .catch((dlqErr: unknown) =>
        logger.error({ queue, jobId: job.id, err, dlqErr }, 'failed to dead-letter job'),
      );
  });
  worker.on('error', (err) => logger.error({ queue, err }, 'queue worker error'));

  return {
    worker,
    close: async () => {
      await worker.close();
      await dlq.close();
    },
  };
}
