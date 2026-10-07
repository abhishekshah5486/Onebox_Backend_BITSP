import { createJobEnvelope, type JobEnvelope } from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import { createLogger } from '@onebox/logger';
import { startRedis, type TestRedis } from '@onebox/testing';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createConsumer } from './consumer';
import { deadLetterQueue } from './policies';
import { createProducer } from './producer';

const logger = createLogger({ service: 'test', level: 'silent' });
const payload = z.object({ uid: z.number() });
const fast = { attempts: 3, backoffMs: 10 };

let redis: TestRedis;
const closers: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  redis = await startRedis();
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  const flush = new Queue('ingest', { connection: { url: redis.url } });
  await flush.obliterate({ force: true });
  await new Queue('ingest-dlq', { connection: { url: redis.url } }).obliterate({ force: true });
  await flush.close();
});

afterAll(() => redis.stop());

function setup(handler: (envelope: JobEnvelope<{ uid: number }>) => Promise<void>) {
  const producer = createProducer<{ uid: number }>('ingest', {
    redisUrl: redis.url,
    logger,
    policy: fast,
  });
  const consumer = createConsumer('ingest', payload, handler, { redisUrl: redis.url, logger });
  closers.push(producer.close, consumer.close);
  return { producer, consumer };
}

const envelope = (jobId: string, uid = 1) =>
  createJobEnvelope({ jobId, userId: 'u1', accountId: 'a1', traceId: 't1', payload: { uid } });

async function deadLetters() {
  const dlq = new Queue(deadLetterQueue('ingest'), { connection: { url: redis.url } });
  const jobs = await dlq.getJobs(['waiting']);
  await dlq.close();
  return jobs.map((job) => job.data as { jobId: string; error: string; attemptsMade: number });
}

describe('queue', () => {
  it('delivers the validated envelope to the handler', async () => {
    const handler = vi.fn(async (_envelope: JobEnvelope<{ uid: number }>) => {});
    const { producer } = setup(handler);

    await producer.enqueue(envelope('job-1', 42));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler.mock.calls[0]![0]).toMatchObject({
      jobId: 'job-1',
      traceId: 't1',
      payload: { uid: 42 },
    });
  });

  it('ignores a duplicate job id', async () => {
    const handler = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    const { producer } = setup(handler);

    const first = await producer.enqueue(envelope('dup-1'));
    const second = await producer.enqueue(envelope('dup-1'));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  });

  it('retries transient failures until they succeed', async () => {
    let calls = 0;
    const { producer } = setup(async () => {
      calls += 1;
      if (calls < 3) throw new Error('mongo blip');
    });

    await producer.enqueue(envelope('retry-1'));
    await vi.waitFor(() => expect(calls).toBe(3), { timeout: 5000 });
    expect(await deadLetters()).toHaveLength(0);
  });

  it('dead-letters a job after its retries are exhausted', async () => {
    const handler = vi.fn(async () => {
      throw new Error('always broken');
    });
    const { producer } = setup(handler);

    await producer.enqueue(envelope('dead-1'));

    await vi.waitFor(async () => expect(await deadLetters()).toHaveLength(1), { timeout: 5000 });
    expect((await deadLetters())[0]).toMatchObject({
      jobId: 'dead-1',
      error: 'always broken',
      attemptsMade: 3,
    });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('skips retries for non-retryable errors', async () => {
    const handler = vi.fn(async () => {
      throw new ValidationError('unparseable message');
    });
    const { producer } = setup(handler);

    await producer.enqueue(envelope('fatal-1'));

    await vi.waitFor(async () => expect(await deadLetters()).toHaveLength(1), { timeout: 5000 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('dead-letters malformed envelopes without calling the handler', async () => {
    const handler = vi.fn(async () => {});
    setup(handler);
    const raw = new Queue('ingest', { connection: { url: redis.url } });
    await raw.add(
      'ingest',
      { jobId: 'bad', payload: { uid: 'nope' } },
      { jobId: 'bad', attempts: 3 },
    );
    await raw.close();

    await vi.waitFor(async () => expect(await deadLetters()).toHaveLength(1), { timeout: 5000 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('waits until a batch of jobs has been processed', async () => {
    const done: string[] = [];
    const { producer } = setup(async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      done.push(job.jobId);
    });
    await producer.enqueue(envelope('w-1'));
    await producer.enqueue(envelope('w-2'));

    expect(await producer.waitUntilProcessed(['w-1', 'w-2', 'never-enqueued'])).toBe(true);
    expect(done.sort()).toEqual(['w-1', 'w-2']);
  });

  it('gives up waiting after the timeout', async () => {
    const { producer } = setup(() => new Promise((resolve) => setTimeout(resolve, 2000)));
    await producer.enqueue(envelope('slow-1'));
    expect(await producer.waitUntilProcessed(['slow-1'], { timeoutMs: 200, intervalMs: 50 })).toBe(
      false,
    );
  });

  it('reports pending work for backpressure', async () => {
    const producer = createProducer<{ uid: number }>('ingest', {
      redisUrl: redis.url,
      logger,
      policy: fast,
    });
    closers.push(producer.close);
    await producer.enqueue(envelope('p-1'));
    await producer.enqueue(envelope('p-2'));
    expect(await producer.pending()).toBe(2);
  });
});
