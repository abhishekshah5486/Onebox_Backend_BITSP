import type { IndexPayload, JobEnvelope, LiveEvent } from '@onebox/contracts';
import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { createLogger } from '@onebox/logger';
import { startMongo, type TestMongo } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mailCollections, type MailCollections, type ThreadDoc } from '../db/collections';
import { enableThreadPreImages, startLiveFeed } from './live-feed';
import { RESUME_KEY, startSearchFeed } from './search-feed';
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
  it('backfills stored mail, follows changes, and resumes where it stopped', async () => {
    await collections.messages.insertOne({
      ...storedMessage(),
      htmlBody: '<p>x</p>',
    });
    const redis = memoryRedis();
    const index = recordingQueue();
    const embed = recordingQueue();

    const first = startSearchFeed({
      db: handle.db,
      messages: collections.messages,
      redis,
      queues: [index, embed],
      logger,
    });
    await vi.waitFor(() => expect(index.jobs).toHaveLength(1), { timeout: 10_000 });
    expect(index.jobs[0]!.payload).toMatchObject({ op: 'upsert', doc: { messageId: 'm1' } });
    expect(embed.jobs).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 500));

    await collections.messages.updateOne({ _id: 'm1' }, { $set: { pendingSince: new Date() } });
    await collections.messages.updateOne({ _id: 'm1' }, { $set: { isRead: true } });
    await vi.waitFor(() => expect(index.jobs).toHaveLength(2), { timeout: 10_000 });
    expect(index.jobs[1]!.payload).toMatchObject({ op: 'upsert', doc: { isRead: true } });
    await vi.waitFor(() => expect(redis.store.has(RESUME_KEY)).toBe(true));
    await first.close();

    // Changes made while it was stopped arrive once it starts again, without a second backfill.
    await collections.messages.deleteOne({ _id: 'm1' });
    const second = startSearchFeed({
      db: handle.db,
      messages: collections.messages,
      redis,
      queues: [index],
      logger,
    });
    await vi.waitFor(() => expect(index.jobs).toHaveLength(3), { timeout: 10_000 });
    expect(index.jobs[2]!.payload).toEqual({ op: 'delete', messageId: 'm1' });
    await second.close();
  });
});
