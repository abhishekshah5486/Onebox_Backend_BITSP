import { randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { UnauthorizedError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { HISTORY_BATCH_SIZE, QUEUES, type HistoryPayload } from '@onebox/contracts';
import { createMailboxStore, type MailboxStore } from '@onebox/mailbox-state';
import { createProducer } from '@onebox/queue';
import { startMongo, startRedis, type TestMongo, type TestRedis } from '@onebox/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { ensureIndexes, mailCollections, type MailCollections } from '../db/collections';
import { createIngestHandler } from '../ingest/ingest-message';
import { ingestJob } from '../test/fixtures';
import { createMailService } from './mail-service';
import { createMailboxService } from './mailbox-service';

const logger = createLogger({ service: 'test', level: 'silent' });
const context = { logger, attempt: 1 };
const verifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith('user-')) throw new UnauthorizedError('Invalid access token');
  return { userId: token.slice(5), email: 'x@onebox.dev' };
};

let mongo: TestMongo;
let handle: MongoHandle;
let collections: MailCollections;
let app: HttpServer;
let ingest: ReturnType<typeof createIngestHandler>;
let redisContainer: TestRedis;
let redis: Redis;
let store: MailboxStore;
let historyQueue: Queue;
let historyProducer: ReturnType<typeof createProducer<HistoryPayload>>;

beforeAll(async () => {
  mongo = await startMongo();
  handle = await connectMongo(mongo.uri, 'onebox_mail_api_test');
  collections = mailCollections(handle.db);
  await ensureIndexes(collections);
  ingest = createIngestHandler(collections);
  redisContainer = await startRedis();
  redis = new Redis(redisContainer.url);
  store = createMailboxStore(redis);
  historyQueue = new Queue(QUEUES.history, { connection: { url: redisContainer.url } });
  historyProducer = createProducer<HistoryPayload>(QUEUES.history, {
    redisUrl: redisContainer.url,
    logger,
  });
  app = buildApp({
    logger,
    checks: {},
    routes: {
      mail: createMailService(collections),
      mailboxes: createMailboxService({ collections, store, historyProducer, logger }),
      verifyToken,
    },
  });
});

beforeEach(async () => {
  await collections.messages.deleteMany({});
  await collections.threads.deleteMany({});
});

afterAll(async () => {
  await historyProducer.close();
  await historyQueue.close();
  redis.disconnect();
  await redisContainer.stop();
  await app.close();
  await handle.close();
  await mongo.stop();
});

const as = (userId: string) => ({ authorization: `Bearer user-${userId}` });

interface Thread {
  id: string;
  subject: string;
  unreadCount: number;
  isStarred: boolean;
  accountId: string;
}

async function seed(userId: string, count: number, accountId = randomUUID()) {
  for (let i = 0; i < count; i++) {
    const minute = String(i).padStart(2, '0');
    await ingest(
      ingestJob({
        userId,
        accountId,
        subject: `Subject ${i}`,
        messageId: `<${userId}-${i}@x>`,
        date: `Tue, 06 Oct 2026 10:${minute}:00 +0000`,
      }),
      context,
    );
  }
  return accountId;
}

const list = (userId: string, query = '') =>
  app.inject({ url: `/mail/threads${query}`, headers: as(userId) });

describe('mail api', () => {
  it('requires authentication', async () => {
    expect((await app.inject({ url: '/mail/threads' })).statusCode).toBe(401);
  });

  it('lists conversations newest first', async () => {
    const userId = randomUUID();
    await seed(userId, 3);
    const res = await list(userId);
    expect(res.json<{ items: Thread[] }>().items.map((t) => t.subject)).toEqual([
      'Subject 2',
      'Subject 1',
      'Subject 0',
    ]);
  });

  it('pages through every conversation exactly once with page numbers', async () => {
    const userId = randomUUID();
    await seed(userId, 7);
    const pages = await Promise.all(
      [1, 2, 3].map(async (n) =>
        (await list(userId, `?limit=3&page=${n}`)).json<{
          items: Thread[];
          total: number;
          page: number;
        }>(),
      ),
    );

    expect(pages.map((p) => p.items.length)).toEqual([3, 3, 1]);
    expect(pages.every((p) => p.total === 7)).toBe(true);
    const seen = pages.flatMap((p) => p.items.map((t) => t.subject));
    expect(new Set(seen).size).toBe(7);
    expect((await list(userId, '?limit=3&page=4')).json()).toMatchObject({ items: [], total: 7 });
  });

  it('shifts pages down when new mail arrives, like Gmail', async () => {
    const userId = randomUUID();
    const accountId = await seed(userId, 4);
    const before = (await list(userId, '?limit=2&page=2'))
      .json<{ items: Thread[] }>()
      .items.map((t) => t.subject);
    await ingest(
      ingestJob({
        userId,
        accountId,
        subject: 'Brand new',
        messageId: `<${userId}-new@x>`,
        date: 'Tue, 06 Oct 2026 11:00:00 +0000',
      }),
      context,
    );
    const after = (await list(userId, '?limit=2&page=2'))
      .json<{ items: Thread[] }>()
      .items.map((t) => t.subject);
    expect(after).toEqual(['Subject 2', before[0]]);
  });

  it('never shows another user mail', async () => {
    const [alice, bob] = [randomUUID(), randomUUID()];
    await seed(alice, 2);
    expect((await list(bob)).json()).toEqual({ items: [], page: 1, pageSize: 50, total: 0 });

    const aliceThread = (await list(alice)).json<{ items: Thread[] }>().items[0]!;
    const peek = await app.inject({ url: `/mail/threads/${aliceThread.id}`, headers: as(bob) });
    expect(peek.statusCode).toBe(404);
  });

  it('opens a conversation with its sanitized messages', async () => {
    const userId = randomUUID();
    await seed(userId, 1);
    const { id } = (await list(userId)).json<{ items: Thread[] }>().items[0]!;
    const res = await app.inject({ url: `/mail/threads/${id}`, headers: as(userId) });
    expect(res.json()).toMatchObject({
      thread: { id, subject: 'Subject 0' },
      messages: [
        { subject: 'Subject 0', from: { address: 'priya@acme.example' }, textBody: 'Hello there' },
      ],
    });
  });

  it('marks read, stars, and filters', async () => {
    const userId = randomUUID();
    await seed(userId, 2);
    const [first] = (await list(userId)).json<{ items: Thread[] }>().items;
    const patch = (payload: object) =>
      app.inject({
        method: 'PATCH',
        url: `/mail/threads/${first!.id}`,
        headers: as(userId),
        payload,
      });

    expect((await patch({ isRead: true })).json()).toMatchObject({ unreadCount: 0 });
    expect((await patch({ isStarred: true })).json()).toMatchObject({ isStarred: true });

    const unread = (await list(userId, '?filter=unread')).json<{ items: Thread[] }>().items;
    const starred = (await list(userId, '?filter=starred')).json<{ items: Thread[] }>().items;
    expect(unread.map((t) => t.id)).not.toContain(first!.id);
    expect(starred.map((t) => t.id)).toEqual([first!.id]);

    expect((await app.inject({ url: '/mail/stats', headers: as(userId) })).json()).toEqual({
      unreadThreads: 1,
      starredThreads: 1,
      totalThreads: 2,
    });
    expect((await patch({ isStarred: false })).json()).toMatchObject({ isStarred: false });
  });

  it('filters by account', async () => {
    const userId = randomUUID();
    const work = await seed(userId, 2);
    await seed(userId, 1);
    const items = (await list(userId, `?accountId=${work}`)).json<{ items: Thread[] }>().items;
    expect(items).toHaveLength(2);
    expect(items.every((t) => t.accountId === work)).toBe(true);
  });

  it('orders conversations from the same second by uid so pages match fetch order', async () => {
    const userId = randomUUID();
    const accountId = randomUUID();
    for (const uid of [5, 3, 9, 1, 7]) {
      await ingest(
        ingestJob({
          userId,
          accountId,
          uid,
          subject: `uid ${uid}`,
          messageId: `<${userId}-${uid}@x>`,
          date: 'Tue, 06 Oct 2026 10:00:00 +0000',
        }),
        context,
      );
    }
    const page = (await list(userId, '?limit=10')).json<{ items: Thread[] }>();
    expect(page.items.map((t) => t.subject)).toEqual(['uid 9', 'uid 7', 'uid 5', 'uid 3', 'uid 1']);

    const rest = (await list(userId, '?limit=2&page=2')).json<{ items: Thread[] }>();
    expect(rest.items.map((t) => t.subject)).toEqual(['uid 5', 'uid 3']);
  });

  it('lists one account at a time', async () => {
    const userId = randomUUID();
    const work = await seed(userId, 2);
    await seed(userId, 3);
    const res = await app.inject({ url: `/mail/accounts/${work}/threads`, headers: as(userId) });
    const items = res.json<{ items: Thread[] }>().items;
    expect(items).toHaveLength(2);
    expect(items.every((t) => t.accountId === work)).toBe(true);
  });

  describe('mailbox history', () => {
    async function withCounts(userId: string, accountId: string, total: number) {
      await store.setCounts({
        userId,
        accountId,
        folder: 'INBOX',
        uidValidity: 1,
        total,
        unread: 7,
        updatedAt: new Date().toISOString(),
      });
    }
    const summaryOf = (userId: string, accountId: string) =>
      app.inject({ url: `/mail/accounts/${accountId}/summary`, headers: as(userId) });
    const requestHistory = (userId: string, accountId: string) =>
      app.inject({
        method: 'POST',
        url: `/mail/accounts/${accountId}/history`,
        headers: as(userId),
      });
    const historyJobs = async (accountId: string) =>
      (await historyQueue.getJobs(['waiting'])).filter(
        (job) => (job.data as { accountId: string }).accountId === accountId,
      );

    it('reports server totals next to what is stored', async () => {
      const userId = randomUUID();
      const accountId = await seed(userId, 3);
      await withCounts(userId, accountId, 4586);

      expect((await summaryOf(userId, accountId)).json()).toMatchObject({
        server: { total: 4586, unread: 7 },
        fetched: { conversations: 3, messages: 3 },
        history: { status: 'idle' },
        hasMoreOnServer: true,
      });
    });

    it("hides another user's mailbox", async () => {
      const owner = randomUUID();
      const accountId = await seed(owner, 1);
      await withCounts(owner, accountId, 10);
      expect((await summaryOf(randomUUID(), accountId)).statusCode).toBe(404);
      expect((await requestHistory(randomUUID(), accountId)).statusCode).toBe(404);
    });

    it('refuses to page back before the first sync has finished', async () => {
      const res = await requestHistory(randomUUID(), randomUUID());
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'MAILBOX_NOT_READY' } });
    });

    it('requests the page just before the oldest stored message, once', async () => {
      const userId = randomUUID();
      const accountId = await seed(userId, 3);
      await withCounts(userId, accountId, 500);
      const oldestUid = (
        await collections.messages.find({ accountId }).sort({ uid: 1 }).limit(1).toArray()
      )[0]!.uid;

      const first = await requestHistory(userId, accountId);
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ history: { status: 'fetching' } });
      await requestHistory(userId, accountId);

      const jobs = await historyJobs(accountId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data).toMatchObject({
        payload: { beforeUid: oldestUid, count: HISTORY_BATCH_SIZE, uidValidity: 1 },
      });
    });

    it('does nothing once the whole mailbox is fetched', async () => {
      const userId = randomUUID();
      const accountId = await seed(userId, 1);
      await withCounts(userId, accountId, 1);
      await store.setHistory(accountId, 'INBOX', 'complete');

      const res = await requestHistory(userId, accountId);
      expect(res.json()).toMatchObject({ hasMoreOnServer: false, history: { status: 'complete' } });
      expect(await historyJobs(accountId)).toHaveLength(0);
    });
  });

  it.each([
    ['/mail/threads/not-a-thread-id', 400],
    ['/mail/threads?page=0', 400],
    ['/mail/threads?limit=500', 400],
    [`/mail/threads/${'a'.repeat(64)}`, 404],
  ])('%s -> %i', async (url, status) => {
    expect((await app.inject({ url, headers: as(randomUUID()) })).statusCode).toBe(status);
  });
});
