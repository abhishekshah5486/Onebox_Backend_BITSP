import type { IndexPayload, JobEnvelope, LiveEvent } from '@onebox/contracts';
import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { createLogger } from '@onebox/logger';
import { startMongo, type TestMongo } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mailCollections, type MailCollections, type ThreadDoc } from '../db/collections';
import { enableThreadPreImages, startLiveFeed } from './live-feed';
import { BACKFILL_KEY, RESUME_KEY, START_KEY, startSearchFeed } from './search-feed';
import { storedMessage } from '../test/fixtures';

const logger = createLogger({ service: 'test', level: 'silent' });

let mongo: TestMongo;
let handle: MongoHandle;
let collections: MailCollections;

beforeAll(async () => {
  mongo = await startMongo();
  handle = await connectMongo(mongo.uri, 'onebox_mail_feed_test');
  collections = mailCollections(handle.db);
  await handle.db.createCollection('threads');
  await enableThreadPreImages(handle.db);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await mongo?.stop();
});

const memoryRedis = () => {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    del: vi.fn(async (key: string) => Number(store.delete(key))),
  };
};

const recordingQueue = () => {
  const jobs: JobEnvelope<IndexPayload>[] = [];
  return {
    jobs,
    enqueue: vi.fn(async (job: JobEnvelope<IndexPayload>) => {
      jobs.push(job);
      return { jobId: job.jobId, duplicate: false };
    }),
  };
};

describe('live feed', () => {
  it('publishes changed and removed conversations to their owner', async () => {
    const events: [string, LiveEvent][] = [];
    const feed = startLiveFeed({
      threads: collections.threads,
      publish: async (userId, event) => events.push([userId, event]),
      logger,
    });
    // Let the stream open before writing.
    await new Promise((resolve) => setTimeout(resolve, 500));

    await collections.threads.insertOne({ _id: 't1', userId: 'u1', accountId: 'a1' } as ThreadDoc);
    await collections.threads.updateOne({ _id: 't1' }, { $set: { unreadCount: 0 } });
    await collections.threads.deleteOne({ _id: 't1' });

    await vi.waitFor(() => expect(events).toHaveLength(3), { timeout: 10_000 });
    expect(events.at(-1)).toEqual(['u1', { type: 'thread.removed', threadId: 't1' }]);
    expect(events[0]![1]).toEqual({ type: 'thread.changed', threadId: 't1', accountId: 'a1' });
    await feed.close();
  });
});

describe('search feed', () => {
  const copy = (id: string, overrides: Parameters<typeof storedMessage>[0] = {}) => ({
    ...storedMessage({ _id: id, messageIdHeader: '<quote@acme>', ...overrides }),
    htmlBody: '<p>x</p>',
  });
  const feedWith = (redis: ReturnType<typeof memoryRedis>, queue = recordingQueue()) => ({
    queue,
    feed: startSearchFeed({
      db: handle.db,
      messages: collections.messages,
      redis,
      queues: [queue],
      logger,
    }),
  });

  it('backfills each email once, however many folders hold it', async () => {
    await collections.messages.deleteMany({});
    await collections.messages.insertMany([
      copy('m1'),
      copy('m2', { folder: '[Gmail]/All Mail', role: 'archive' }),
      copy('m3', { messageIdHeader: null }),
    ]);
    const redis = memoryRedis();
    const { queue, feed } = feedWith(redis);
    await vi.waitFor(() => expect(redis.store.has(START_KEY)).toBe(true), { timeout: 10_000 });
    await feed.close();

    expect(queue.jobs).toHaveLength(2);
    const copies = queue.jobs.map((job) =>
      job.payload.op === 'upsert' ? job.payload.doc.copies.map((c) => c.messageId) : [],
    );
    expect(copies).toEqual(expect.arrayContaining([['m1', 'm2'], ['m3']]));
    expect(redis.store.has(BACKFILL_KEY)).toBe(false);
  });

  it('rebuilds the whole email on a change, and removes a copy by id', async () => {
    const redis = memoryRedis();
    const { queue, feed } = feedWith(redis);
    await vi.waitFor(() => expect(redis.store.has(START_KEY)).toBe(true), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    queue.jobs.length = 0;

    await collections.messages.updateOne({ _id: 'm1' }, { $set: { pendingSince: new Date() } });
    await collections.messages.updateOne({ _id: 'm2' }, { $set: { isRead: true } });
    await collections.messages.deleteOne({ _id: 'm1' });
    await vi.waitFor(() => expect(queue.jobs).toHaveLength(2), { timeout: 10_000 });

    const [changed, removed] = queue.jobs.map((job) => job.payload);
    expect(changed).toMatchObject({ op: 'upsert', doc: { userId: 'u1' } });
    expect(removed).toMatchObject({ op: 'delete', messageId: 'm1' });
    expect(removed!.version).toBeGreaterThan(changed!.version);
    await vi.waitFor(() => expect(redis.store.has(RESUME_KEY)).toBe(true));
    await feed.close();

    // Changes made while it was stopped arrive once it starts again, without a second backfill.
    await collections.messages.deleteOne({ _id: 'm2' });
    const again = feedWith(redis);
    await vi.waitFor(() => expect(again.queue.jobs).toHaveLength(1), { timeout: 10_000 });
    expect(again.queue.jobs[0]!.payload).toMatchObject({ op: 'delete', messageId: 'm2' });
    await again.feed.close();
  });

  it('starts after its backfill when stopped before any change arrived', async () => {
    await collections.messages.deleteMany({});
    await collections.messages.insertOne(copy('m5', { isStarred: true }));
    const redis = memoryRedis();
    const first = feedWith(redis);
    await vi.waitFor(() => expect(redis.store.has(START_KEY)).toBe(true), { timeout: 10_000 });
    await first.feed.close();
    expect(redis.store.has(RESUME_KEY)).toBe(false);

    await collections.messages.updateOne({ _id: 'm5' }, { $set: { isStarred: false } });
    const second = feedWith(redis, first.queue);
    await vi.waitFor(() => expect(first.queue.jobs).toHaveLength(2), { timeout: 10_000 });
    expect(first.queue.jobs.map((job) => job.jobId.split('-')[0])).toEqual(['backfill', 'change']);
    await second.feed.close();
  });

  it('re-queues an interrupted backfill under the same job ids', async () => {
    const redis = memoryRedis();
    redis.store.set(BACKFILL_KEY, 'run1');
    const { queue, feed } = feedWith(redis);
    await vi.waitFor(() => expect(redis.store.has(START_KEY)).toBe(true), { timeout: 10_000 });
    await feed.close();
    expect(queue.jobs[0]!.jobId).toMatch(/^backfill-run1-[0-9a-f]{40}$/);
  });
});
