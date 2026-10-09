import { randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { UnauthorizedError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import {
  HISTORY_BATCH_SIZE,
  QUEUES,
  type HistoryPayload,
  type MailboxOpPayload,
  type MessageOpPayload,
} from '@onebox/contracts';
import { createMailboxStore, type MailboxStore } from '@onebox/mailbox-state';
import { createProducer } from '@onebox/queue';
import { startMongo, startRedis, type TestMongo, type TestRedis } from '@onebox/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { ensureIndexes, mailCollections, type MailCollections } from '../db/collections';
import { createMemoryBlobStore } from '@onebox/blob-store';
import { createAttachmentService } from '../attachments/attachments';
import { googleDriveUploader } from '../storage/google-drive';
import { dropboxUploader } from '../storage/dropbox';
import { oneDriveUploader } from '../storage/onedrive';
import { createStorageService } from '../storage/storage';
import { createIngestHandler } from '../ingest/ingest-message';
import { ingestJob } from '../test/fixtures';
import { createMailService } from './mail-service';
import { createMailboxService } from './mailbox-service';
import { createLabelService } from './label-service';
import { createThreadActions } from './thread-actions';

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
const blobs = createMemoryBlobStore();
let redisContainer: TestRedis;
let redis: Redis;
let store: MailboxStore;
let historyQueue: Queue;
let historyProducer: ReturnType<typeof createProducer<HistoryPayload>>;
let opsQueue: Queue;
let opsProducer: ReturnType<typeof createProducer<MailboxOpPayload>>;
const oneClick: string[] = [];
let oneClickWorks = true;

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
  opsQueue = new Queue(QUEUES.mailboxOps, { connection: { url: redisContainer.url } });
  opsProducer = createProducer<MailboxOpPayload>(QUEUES.mailboxOps, {
    redisUrl: redisContainer.url,
    logger,
  });
  const attachments = createAttachmentService({ collections, blobs, ops: opsProducer, logger });
  app = buildApp({
    logger,
    checks: {},
    routes: {
      mail: createMailService(collections),
      mailboxes: createMailboxService({ collections, store, historyProducer, logger }),
      actions: createThreadActions({
        collections,
        ops: opsProducer,
        logger,
        post: async (url) => {
          oneClick.push(url);
          return { ok: oneClickWorks, status: oneClickWorks ? 200 : 500 };
        },
      }),
      labels: createLabelService({ store, ops: opsProducer, logger, waitMs: 300 }),
      attachments,
      storage: createStorageService({
        attachments,
        settingsUrl: 'http://settings',
        internalToken: 'internal',
        logger,
        uploaders: {
          GOOGLE_DRIVE: googleDriveUploader(logger, driveFetch),
          ONEDRIVE: oneDriveUploader(logger, driveFetch),
          DROPBOX: dropboxUploader(logger, driveFetch),
        },
        fetch: driveFetch,
      }),
      verifyToken,
    },
  });
});

// Stands in for settings' token route and the Google Drive API.
const driveCalls: { url: string; method: string; body?: unknown }[] = [];
const driveFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? 'GET';
  driveCalls.push({ url, method, body: init?.body });
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { headers });
  if (url.includes('/internal/storage/token/')) {
    return json({ provider: 'GOOGLE_DRIVE', accessToken: 'at' });
  }
  if (url.includes('/upload/drive/v3/files')) {
    return json({}, { location: 'https://upload.example/session-1' });
  }
  if (url === 'https://upload.example/session-1') {
    return json({ id: 'file-1', name: 'marks.pdf', webViewLink: 'https://drive.example/file-1' });
  }
  if (method === 'POST') return json({ id: `folder-${driveCalls.length}` });
  return json({ files: [] });
};

beforeEach(async () => {
  await collections.messages.deleteMany({});
  await collections.threads.deleteMany({});
});

afterAll(async () => {
  await historyProducer.close();
  await historyQueue.close();
  await opsProducer.close();
  await opsQueue.close();
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
  folders: string[];
  messageCount: number;
  attachments: { messageId: string; index: number; filename: string }[];
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

  describe('folders', () => {
    const SENT = { path: '[Gmail]/Sent Mail', role: 'sent' as const };
    const TRASH = { path: '[Gmail]/Bin', role: 'trash' as const };

    async function seedFolders(userId: string, accountId: string) {
      const put = (subject: string, folder?: typeof SENT | typeof TRASH, messageId = subject) =>
        ingest(
          ingestJob({
            userId,
            accountId,
            subject,
            messageId: `<${messageId}@x>`,
            flags: ['\\Flagged'],
            ...(folder && { folder }),
          }),
          context,
        );
      await put('Hello inbox');
      await put('Report sent', SENT);
      await put('Old junk', TRASH);
      // Mail to yourself is stored in both Inbox and Sent.
      await put('Note to self');
      await put('Note to self', SENT);
    }

    const subjects = (res: { json: <T>() => T }) =>
      res
        .json<{ items: Thread[] }>()
        .items.map((t) => t.subject)
        .sort();

    it('lists each folder separately and counts a message in two folders once', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await seedFolders(userId, accountId);

      expect(subjects(await list(userId))).toEqual(['Hello inbox', 'Note to self']);
      expect(subjects(await list(userId, '?folder=sent'))).toEqual(['Note to self', 'Report sent']);
      expect(subjects(await list(userId, '?folder=trash'))).toEqual(['Old junk']);
      expect(subjects(await list(userId, '?filter=starred'))).toEqual([
        'Hello inbox',
        'Note to self',
        'Report sent',
      ]);

      const self = (await list(userId))
        .json<{ items: Thread[] }>()
        .items.find((t) => t.subject === 'Note to self')!;
      expect(self).toMatchObject({ folders: ['inbox', 'sent'], messageCount: 1 });
      const detail = await app.inject({ url: `/mail/threads/${self.id}`, headers: as(userId) });
      expect(detail.json<{ messages: unknown[] }>().messages).toHaveLength(1);
    });

    it('lists the folders found on the server with their counts', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      for (const [role, folder, total] of [
        ['inbox', 'INBOX', 120],
        ['sent', '[Gmail]/Sent Mail', 40],
      ] as const) {
        await store.setCounts({
          userId,
          accountId,
          role,
          folder,
          uidValidity: 1,
          total,
          unread: 0,
          updatedAt: new Date().toISOString(),
        });
      }

      const res = await app.inject({
        url: `/mail/accounts/${accountId}/folders`,
        headers: as(userId),
      });
      expect(res.json()).toMatchObject({
        items: [
          { role: 'inbox', path: 'INBOX', total: 120 },
          { role: 'sent', path: '[Gmail]/Sent Mail', total: 40 },
        ],
      });
      const other = await app.inject({
        url: `/mail/accounts/${accountId}/folders`,
        headers: as(randomUUID()),
      });
      expect(other.statusCode).toBe(404);
    });

    it('pages back through a folder using its own path', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await seedFolders(userId, accountId);
      await store.setCounts({
        userId,
        accountId,
        role: 'sent',
        folder: SENT.path,
        uidValidity: 1,
        total: 300,
        unread: 0,
        updatedAt: new Date().toISOString(),
      });

      const summary = await app.inject({
        url: `/mail/accounts/${accountId}/summary?folder=sent`,
        headers: as(userId),
      });
      expect(summary.json()).toMatchObject({
        folder: 'sent',
        server: { total: 300 },
        fetched: { conversations: 2, messages: 2 },
        hasMoreOnServer: true,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/mail/accounts/${accountId}/history?folder=sent`,
        headers: as(userId),
      });
      expect(res.statusCode).toBe(202);
      const [job] = (await historyQueue.getJobs(['waiting'])).filter(
        (j) => (j.data as { accountId: string }).accountId === accountId,
      );
      expect(job!.data).toMatchObject({ payload: { folder: SENT.path, role: 'sent' } });
    });
  });

  describe('conversation actions', () => {
    const LABEL = { path: 'Receipts', role: 'label' as const };
    const act = (userId: string, payload: object) =>
      app.inject({ method: 'POST', url: '/mail/threads/actions', headers: as(userId), payload });
    const opsFor = async (accountId: string) =>
      (await opsQueue.getJobs(['waiting', 'delayed', 'active', 'completed']))
        .map((job) => job.data as { accountId: string; payload: MailboxOpPayload })
        .filter((data) => data.accountId === accountId)
        .map((data) => data.payload as MessageOpPayload);
    const put = (userId: string, accountId: string, spec: Parameters<typeof ingestJob>[0]) =>
      ingest(ingestJob({ userId, accountId, ...spec }), context);
    const ids = async (userId: string, query = '') =>
      (await list(userId, query))
        .json<{ items: Thread[] }>()
        .items.map((t) => t.subject)
        .sort();

    it('looks up conversations by id, only the caller’s own', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await put(userId, accountId, { subject: 'Mine', messageId: '<mine@x>', uid: 491 });
      const [mine] = (await list(userId)).json<{ items: Thread[] }>().items;
      const lookup = (who: string) =>
        app.inject({
          method: 'POST',
          url: '/mail/threads/lookup',
          headers: as(who),
          payload: { threadIds: [mine!.id] },
        });

      expect((await lookup(userId)).json()).toMatchObject({ items: [{ subject: 'Mine' }] });
      expect((await lookup(randomUUID())).json()).toEqual({ items: [] });
    });

    it('archives at once and asks the connector to move the mail on the server', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await put(userId, accountId, { subject: 'Keep', messageId: '<keep@x>', uid: 501 });
      await put(userId, accountId, { subject: 'Done', messageId: '<done@x>', uid: 502 });
      const done = (await list(userId))
        .json<{ items: Thread[] }>()
        .items.find((t) => t.subject === 'Done')!;

      const res = await act(userId, { threadIds: [done.id], action: 'archive' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ items: [{ id: done.id, folders: ['archive'] }] });
      expect(await ids(userId)).toEqual(['Keep']);
      expect(await ids(userId, '?folder=archive')).toEqual(['Done']);
      expect(await opsFor(accountId)).toEqual([
        {
          folder: 'INBOX',
          uidValidity: 1,
          uids: [502],
          op: { type: 'move', to: { role: 'archive' } },
        },
      ]);
    });

    it('undoes a move inside the undo window, once, and only for its owner', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await put(userId, accountId, { subject: 'Oops', messageId: '<oops@x>', uid: 551 });
      const [oops] = (await list(userId)).json<{ items: Thread[] }>().items;

      const archived = await act(userId, { threadIds: [oops!.id], action: 'archive' });
      const { undoToken } = archived.json<{ undoToken: string }>();
      expect(undoToken).toEqual(expect.any(String));
      expect(await ids(userId)).toEqual([]);

      const undo = (who: string) =>
        app.inject({
          method: 'POST',
          url: '/mail/threads/undo',
          headers: as(who),
          payload: { undoToken },
        });
      expect((await undo(randomUUID())).statusCode).toBe(409);
      const undone = await undo(userId);
      expect(undone.statusCode).toBe(200);
      expect(undone.json()).toMatchObject({ items: [{ id: oops!.id, folders: ['inbox'] }] });
      expect(await ids(userId)).toEqual(['Oops']);
      expect(await opsFor(accountId)).toEqual([]);
      expect((await undo(userId)).json()).toMatchObject({ error: { code: 'UNDO_EXPIRED' } });
    });

    it('does not offer undo for read, star or permanent deletion', async () => {
      const userId = randomUUID();
      await put(userId, randomUUID(), { subject: 'Flag me', messageId: '<f@x>', uid: 561 });
      const [thread] = (await list(userId)).json<{ items: Thread[] }>().items;
      const res = await act(userId, { threadIds: [thread!.id], action: 'star' });
      expect(res.json()).toMatchObject({ undoToken: null });
    });

    it('syncs read and starred changes to the server', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await put(userId, accountId, { subject: 'Ping', messageId: '<ping@x>', uid: 601 });
      const [thread] = (await list(userId)).json<{ items: Thread[] }>().items;

      await act(userId, { threadIds: [thread!.id], action: 'read' });
      await app.inject({
        method: 'PATCH',
        url: `/mail/threads/${thread!.id}`,
        headers: as(userId),
        payload: { isStarred: true },
      });
      const flagOps = (await opsFor(accountId)).map((op) => op.op);
      expect(flagOps).toHaveLength(2);
      expect(flagOps).toEqual(
        expect.arrayContaining([
          { type: 'flags', add: ['\\Seen'], remove: [] },
          { type: 'flags', add: ['\\Flagged'], remove: [] },
        ]),
      );
      // Already read: nothing more to send.
      await act(userId, { threadIds: [thread!.id], action: 'read' });
      expect(await opsFor(accountId)).toHaveLength(2);
    });

    it('moves to a label, lists it there and only deletes forever from trash', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await put(userId, accountId, { subject: 'Invoice', messageId: '<inv@x>', uid: 701 });
      await put(userId, accountId, {
        subject: 'Old receipt',
        messageId: '<old@x>',
        uid: 9,
        folder: LABEL,
      });
      const invoice = (await list(userId)).json<{ items: Thread[] }>().items[0]!;

      expect(
        (await act(userId, { threadIds: [invoice.id], action: 'move', to: { label: 'Receipts' } }))
          .statusCode,
      ).toBe(200);
      expect(await ids(userId)).toEqual([]);
      expect(
        await ids(userId, `?accountId=${accountId}&label=${encodeURIComponent('Receipts')}`),
      ).toEqual(['Invoice', 'Old receipt']);

      const refused = await act(userId, { threadIds: [invoice.id], action: 'delete' });
      expect(refused.statusCode).toBe(400);

      await act(userId, {
        threadIds: [invoice.id],
        action: 'move',
        from: { label: 'Receipts' },
        to: { role: 'trash' },
      });
      expect(await ids(userId, '?folder=trash')).toEqual(['Invoice']);
      expect((await act(userId, { threadIds: [invoice.id], action: 'delete' })).statusCode).toBe(
        200,
      );
      expect(await ids(userId, '?folder=trash')).toEqual([]);
      expect((await opsFor(accountId)).map((op) => op.op.type).sort()).toEqual([
        'expunge',
        'move',
        'move',
      ]);
    });

    it('trashes every copy of a conversation and refuses other users', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await put(userId, accountId, { subject: 'Note', messageId: '<n@x>', uid: 801 });
      await put(userId, accountId, {
        subject: 'Note',
        messageId: '<n@x>',
        uid: 802,
        folder: { path: 'Sent', role: 'sent' },
      });
      const [note] = (await list(userId)).json<{ items: Thread[] }>().items;

      expect((await act(randomUUID(), { threadIds: [note!.id], action: 'trash' })).statusCode).toBe(
        404,
      );
      await act(userId, { threadIds: [note!.id], action: 'trash' });
      expect(await ids(userId, '?folder=sent')).toEqual([]);
      expect(await ids(userId, '?folder=trash')).toEqual(['Note']);
      expect((await opsFor(accountId)).map((op) => op.folder).sort()).toEqual(['INBOX', 'Sent']);
    });

    it('filters the inbox by gmail category, with other mail as primary', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await put(userId, accountId, { subject: 'Sale', messageId: '<s@x>', category: 'promotions' });
      await put(userId, accountId, { subject: 'Mum', messageId: '<m@x>', category: 'primary' });
      await put(userId, randomUUID(), { subject: 'Yahoo mail', messageId: '<y@x>' });

      expect(await ids(userId, '?category=promotions')).toEqual(['Sale']);
      expect(await ids(userId, '?category=primary')).toEqual(['Mum', 'Yahoo mail']);
    });

    it('lists a category from every folder but spam and trash', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await put(userId, accountId, {
        subject: 'Order shipped',
        messageId: '<o@x>',
        categories: ['updates', 'purchases'],
      });
      await put(userId, accountId, {
        subject: 'Old receipt',
        messageId: '<r@x>',
        categories: ['purchases'],
        folder: { path: '[Gmail]/All Mail', role: 'archive' },
      });
      await put(userId, accountId, {
        subject: 'Fake receipt',
        messageId: '<f@x>',
        categories: ['purchases'],
        folder: { path: '[Gmail]/Spam', role: 'spam' },
      });
      expect(await ids(userId, '?tagged=purchases')).toEqual(['Old receipt', 'Order shipped']);
    });

    it('unsubscribes with one click, or hands back the link', async () => {
      const userId = randomUUID();
      const accountId = randomUUID();
      await put(userId, accountId, {
        subject: 'Weekly deals',
        messageId: '<deals@x>',
        headers: [
          'List-Unsubscribe: <https://shop.example/u/1>, <mailto:stop@shop.example>',
          'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
        ],
      });
      await put(userId, accountId, {
        subject: 'Digest',
        messageId: '<digest@x>',
        headers: ['List-Unsubscribe: <https://news.example/out>'],
      });
      await put(userId, accountId, { subject: 'Personal', messageId: '<p@x>' });
      const bySubject = Object.fromEntries(
        (await list(userId))
          .json<{ items: (Thread & { canUnsubscribe: boolean })[] }>()
          .items.map((t) => [t.subject, t]),
      );
      expect(bySubject.Personal!.canUnsubscribe).toBe(false);
      const unsubscribe = (id: string) =>
        app.inject({ method: 'POST', url: `/mail/threads/${id}/unsubscribe`, headers: as(userId) });

      expect((await unsubscribe(bySubject['Weekly deals']!.id)).json()).toEqual({
        method: 'one-click',
        url: null,
      });
      expect(oneClick).toContain('https://shop.example/u/1');
      const detail = await app.inject({
        url: `/mail/threads/${bySubject['Weekly deals']!.id}`,
        headers: as(userId),
      });
      expect(
        detail.json<{ thread: { unsubscribedAt: string | null } }>().thread.unsubscribedAt,
      ).not.toBeNull();

      expect((await unsubscribe(bySubject.Digest!.id)).json()).toEqual({
        method: 'link',
        url: 'https://news.example/out',
      });
      oneClickWorks = false;
      expect((await unsubscribe(bySubject['Weekly deals']!.id)).json()).toEqual({
        method: 'link',
        url: 'https://shop.example/u/1',
      });
      oneClickWorks = true;
      expect((await unsubscribe(bySubject.Personal!.id)).statusCode).toBe(400);
    });
  });

  describe('mailbox history', () => {
    async function withCounts(userId: string, accountId: string, total: number) {
      await store.setCounts({
        userId,
        accountId,
        role: 'inbox',
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
      await store.setHistory(accountId, 'inbox', 'complete');

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

  describe('attachments', () => {
    const pdf = Buffer.from('%PDF-1.4 marks');
    const multipart = [
      '--b1',
      'Content-Type: text/plain',
      '',
      'Marksheets attached',
      '--b1',
      'Content-Type: application/pdf; name="marks.pdf"',
      'Content-Disposition: attachment; filename="marks.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf.toString('base64'),
      '--b1',
      'Content-Type: text/html; name="page.html"',
      'Content-Disposition: attachment; filename="page.html"',
      '',
      '<script>alert(1)</script>',
      '--b1--',
    ].join('\r\n');

    it('keeps attachment contents and serves them only to their owner, safely', async () => {
      const userId = randomUUID();
      await createIngestHandler(
        collections,
        undefined,
        blobs,
      )(
        ingestJob({
          userId,
          subject: 'Marksheets',
          headers: ['MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"'],
          body: multipart,
        }),
        context,
      );
      const [thread] = (await list(userId)).json<{ items: Thread[] }>().items;
      expect(thread!.attachments.map((a) => a.filename)).toEqual(['marks.pdf', 'page.html']);
      const { messageId } = thread!.attachments[0]!;
      const get = (who: string, index: number) =>
        app.inject({
          url: `/mail/messages/${messageId}/attachments/${index}?inline=true`,
          headers: as(who),
        });

      const shown = await get(userId, 0);
      expect(shown.statusCode).toBe(200);
      expect(shown.headers['content-type']).toBe('application/pdf');
      expect(shown.headers['content-disposition']).toBe("inline; filename*=UTF-8''marks.pdf");
      expect(shown.rawPayload.equals(pdf)).toBe(true);

      // A web page is never rendered in place.
      const page = await get(userId, 1);
      expect(page.headers['content-type']).toBe('application/octet-stream');
      expect(page.headers['content-disposition']).toMatch(/^attachment;/);
      expect(page.headers['x-content-type-options']).toBe('nosniff');

      expect((await get(randomUUID(), 0)).statusCode).toBe(404);

      const accountId = randomUUID();
      const saved = await app.inject({
        method: 'POST',
        url: `/mail/messages/${messageId}/attachments/save`,
        headers: as(userId),
        payload: { indexes: [0], accountId, path: ' OneBox/Receipts/ ' },
      });
      expect(saved.json()).toEqual({
        files: [{ index: 0, name: 'marks.pdf', link: 'https://drive.example/file-1' }],
      });
      const put = driveCalls.find((call) => call.method === 'PUT');
      expect(Buffer.from(put!.body as Uint8Array).equals(pdf)).toBe(true);
      expect(driveCalls[0]!.url).toContain(`/internal/storage/token/${userId}/${accountId}`);
      // Each missing folder is created inside the one before it, starting at My Drive.
      const folders = driveCalls
        .filter((call) => call.method === 'POST' && call.url.includes('/drive/v3/files?fields'))
        .map((call) => JSON.parse(call.body as string) as { name: string; parents: string[] });
      expect(folders.map((f) => [f.name, f.parents[0]])).toEqual([
        ['OneBox', 'root'],
        ['Receipts', expect.stringMatching(/^folder-/)],
      ]);
    });
  });
});
