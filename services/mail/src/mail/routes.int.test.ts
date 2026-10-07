import { randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { UnauthorizedError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { startMongo, type TestMongo } from '@onebox/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { ensureIndexes, mailCollections, type MailCollections } from '../db/collections';
import { createIngestHandler } from '../ingest/ingest-message';
import { ingestJob } from '../test/fixtures';
import { createMailService } from './mail-service';

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

beforeAll(async () => {
  mongo = await startMongo();
  handle = await connectMongo(mongo.uri, 'onebox_mail_api_test');
  collections = mailCollections(handle.db);
  await ensureIndexes(collections);
  ingest = createIngestHandler(collections);
  app = buildApp({
    logger,
    checks: {},
    routes: { mail: createMailService(collections), verifyToken },
  });
});

beforeEach(async () => {
  await collections.messages.deleteMany({});
  await collections.threads.deleteMany({});
});

afterAll(async () => {
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

  it('pages through every conversation exactly once', async () => {
    const userId = randomUUID();
    await seed(userId, 7);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await list(userId, query)).json<{
        items: Thread[];
        nextCursor: string | null;
      }>();
      seen.push(...page.items.map((t) => t.subject));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('never shows another user mail', async () => {
    const [alice, bob] = [randomUUID(), randomUUID()];
    await seed(alice, 2);
    expect((await list(bob)).json()).toEqual({ items: [], nextCursor: null });

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

  it.each([
    ['/mail/threads/not-a-thread-id', 400],
    ['/mail/threads?cursor=garbage', 400],
    ['/mail/threads?limit=500', 400],
    [`/mail/threads/${'a'.repeat(64)}`, 404],
  ])('%s -> %i', async (url, status) => {
    expect((await app.inject({ url, headers: as(randomUUID()) })).statusCode).toBe(status);
  });
});
