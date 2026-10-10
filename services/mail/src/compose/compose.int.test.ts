import { randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import { createMemoryBlobStore } from '@onebox/blob-store';
import type { JobEnvelope, SendPayload } from '@onebox/contracts';
import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { UnauthorizedError } from '@onebox/errors';
import { createServer, type HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { startMongo, type TestMongo } from '@onebox/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AttachmentService } from '../attachments/attachments';
import { ensureIndexes, mailCollections, type MailCollections } from '../db/collections';
import { createIngestHandler } from '../ingest/ingest-message';
import { ingestJob } from '../test/fixtures';
import type { SenderAccount } from './accounts-client';
import { composeCollections, ensureComposeIndexes, type ComposeCollections } from './collections';
import { createComposeService, type ComposeService } from './compose-service';
import type { StorageService } from '../storage/storage';
import { registerComposeRoutes } from './routes';

const logger = createLogger({ service: 'test', level: 'silent' });
const verifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith('user-')) throw new UnauthorizedError('Invalid access token');
  return { userId: token.slice(5), email: 'x@onebox.dev' };
};

let mongo: TestMongo;
let handle: MongoHandle;
let mail: MailCollections;
let store: ComposeCollections;
let compose: ComposeService;
let app: HttpServer;
const blobs = createMemoryBlobStore();
const queued: { envelope: JobEnvelope<SendPayload>; delayMs: number | undefined }[] = [];
let alreadySent = false;

const ACCOUNT = '5b1f8c2e-7a3d-4e6f-9a1b-2c3d4e5f6a7b';
const accounts: Record<string, SenderAccount> = {
  [ACCOUNT]: {
    id: ACCOUNT,
    userId: 'user-1',
    emailAddress: 'me@acme.example',
    displayName: 'Me',
    status: 'CONNECTED',
  },
};

beforeAll(async () => {
  mongo = await startMongo();
  handle = await connectMongo(mongo.uri, 'onebox_mail_compose_test');
  mail = mailCollections(handle.db);
  store = composeCollections(handle.db);
  await Promise.all([ensureIndexes(mail), ensureComposeIndexes(store)]);
  compose = createComposeService({
    collections: store,
    mail,
    blobs,
    attachments: {
      open: async (_userId: string, _messageId: string, index: number) => ({
        meta: {
          filename: `file-${index}.pdf`,
          contentType: 'application/pdf',
          sizeBytes: 10,
          sha256: 'abc',
        },
      }),
    } as unknown as AttachmentService,
    accounts: async (id) => {
      const account = accounts[id];
      if (!account) throw new Error('missing');
      return account;
    },
    sends: {
      enqueue: async (envelope, options) => {
        queued.push({ envelope, delayMs: options?.delayMs });
        return { jobId: envelope.jobId, duplicate: false };
      },
      cancel: async (jobIds) =>
        alreadySent
          ? null
          : queued.filter((q) => jobIds.includes(q.envelope.jobId)).map((q) => q.envelope),
    },
    logger,
  });
  app = createServer({ logger });
  app.decorateRequest('user', null);
  registerComposeRoutes(app, {
    compose,
    verifyToken,
    storage: {
      shareFile: async (
        _userId: string,
        accountId: string,
        file: { name: string; body: Buffer },
      ) => ({
        name: file.name,
        link: `https://drive.example/${accountId}/${file.name}`,
        provider: 'GOOGLE_DRIVE',
        sizeBytes: file.body.length,
      }),
    } as unknown as StorageService,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await handle.close();
  await mongo.stop();
});

beforeEach(() => {
  queued.length = 0;
  alreadySent = false;
});

const as = (userId = 'user-1') => ({ authorization: `Bearer user-${userId}` });
const message = {
  accountId: ACCOUNT,
  to: [{ name: 'Priya', address: 'priya@acme.example' }],
  subject: 'Pricing',
  html: '<p>Hi</p>',
  text: 'Hi',
};
const send = (payload: object, userId = 'user-1') =>
  app.inject({ method: 'POST', url: '/mail/send', headers: as(userId), payload });

describe('drafts', () => {
  it("saves under the editor's id, lists newest first, and keeps them private", async () => {
    const id = randomUUID();
    const put = (payload: object, userId = 'user-1') =>
      app.inject({ method: 'PUT', url: `/mail/drafts/${id}`, headers: as(userId), payload });
    expect((await put({ ...message, subject: 'First' })).statusCode).toBe(200);
    const saved = await put({ ...message, subject: 'Second' });
    expect(saved.json()).toMatchObject({ id, subject: 'Second', cc: [], note: null });

    const list = await app.inject({ url: '/mail/drafts', headers: as() });
    expect(list.json<{ items: { id: string }[] }>().items[0]!.id).toBe(id);
    expect((await put({ ...message }, 'someone-else')).statusCode).toBe(404);
    expect(
      (await app.inject({ url: `/mail/drafts/${id}`, headers: as('someone-else') })).statusCode,
    ).toBe(404);

    await app.inject({ method: 'DELETE', url: `/mail/drafts/${id}`, headers: as() });
    expect((await app.inject({ url: `/mail/drafts/${id}`, headers: as() })).statusCode).toBe(404);
  });
});

describe('sending', () => {
  it('queues a message behind the undo window and drops its draft', async () => {
    const draftId = randomUUID();
    await compose.putDraft('user-1', draftId, {
      ...message,
      cc: [],
      bcc: [],
      attachments: [],
      replyTo: null,
    });
    const res = await send({ ...message, draftId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'scheduled', subject: 'Pricing' });

    expect(queued).toHaveLength(1);
    expect(queued[0]!.delayMs).toBe(5_000);
    expect(queued[0]!.envelope.payload).toMatchObject({
      to: [{ name: 'Priya', address: 'priya@acme.example' }],
      inReplyTo: null,
    });
    expect(queued[0]!.envelope.payload.messageId).toMatch(/^<[0-9a-f-]{36}@acme\.example>$/);
    expect(await store.drafts.findOne({ _id: draftId })).toBeNull();
  });

  it('schedules a message for later, and refuses times in the past', async () => {
    const sendAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    const res = await send({ ...message, sendAt });
    expect(res.json()).toMatchObject({ status: 'scheduled', sendAt });
    expect(queued[0]!.delayMs).toBeGreaterThan(2 * 3600_000 - 5_000);
    const past = await send({ ...message, sendAt: new Date(Date.now() - 1000).toISOString() });
    expect(past.statusCode).toBe(400);
  });

  it("refuses mail without recipients, from other accounts, or with files that aren't yours", async () => {
    expect((await send({ ...message, to: [] })).statusCode).toBe(400);
    expect((await send(message, 'someone-else')).statusCode).toBe(404);
    const foreign = {
      blobKey: 'uploads/someone-else/x',
      filename: 'x.pdf',
      contentType: 'application/pdf',
      sizeBytes: 3,
    };
    expect((await send({ ...message, attachments: [foreign] })).statusCode).toBe(400);
    expect(queued).toHaveLength(0);
  });

  it('threads a reply onto the message it answers', async () => {
    await createIngestHandler(
      mail,
      async () => {},
      blobs,
    )(
      ingestJob({
        messageId: '<q1@acme.example>',
        references: '<root@acme.example>',
        subject: 'Question',
      }),
      { logger, attempt: 1 },
    );
    const original = (await mail.messages.findOne({ messageIdHeader: '<q1@acme.example>' }))!;
    const res = await send({ ...message, replyTo: { messageId: original._id, mode: 'reply' } });
    expect(res.json()).toMatchObject({ threadId: original.threadId });
    expect(queued[0]!.envelope.payload).toMatchObject({
      inReplyTo: '<q1@acme.example>',
      references: ['<root@acme.example>', '<q1@acme.example>'],
    });
  });

  it('undoes a message that has not gone yet, giving it back as a draft', async () => {
    const { id } = (await send(message)).json<{ id: string }>();
    const undo = await app.inject({
      method: 'POST',
      url: `/mail/outbox/${id}/cancel`,
      headers: as(),
    });
    expect(undo.json()).toMatchObject({ subject: 'Pricing', to: message.to });
    expect((await store.outbox.findOne({ _id: id }))!.status).toBe('cancelled');

    const late = (await send(message)).json<{ id: string }>();
    alreadySent = true;
    const tooLate = await app.inject({
      method: 'POST',
      url: `/mail/outbox/${late.id}/cancel`,
      headers: as(),
    });
    expect(tooLate.statusCode).toBe(409);
  });

  it('records the result, and a failed message comes back as a draft saying why', async () => {
    const sent = (await send(message)).json<{ id: string }>();
    await compose.applyResult(sent.id, 'sent', null);
    expect((await store.outbox.findOne({ _id: sent.id }))!).toMatchObject({ status: 'sent' });

    const failed = (await send({ ...message, subject: 'Bounced' })).json<{ id: string }>();
    await compose.applyResult(failed.id, 'failed', 'Unknown recipient');
    const draft = await app.inject({ url: `/mail/drafts/failed-${failed.id}`, headers: as() });
    expect(draft.json()).toMatchObject({ subject: 'Bounced', note: 'Unknown recipient' });
    const outbox = await app.inject({ url: '/mail/outbox', headers: as() });
    expect(outbox.json<{ items: { id: string; status: string }[] }>().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: failed.id, status: 'failed' })]),
    );
  });
});

describe('attachments and contacts', () => {
  it('takes a file as the request body and names it from the headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mail/uploads',
      headers: {
        ...as(),
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('Q4 plan.json'),
        'x-content-type': 'application/json',
      },
      payload: Buffer.from('{"seats":20}'),
    });
    expect(res.statusCode).toBe(200);
    const uploaded = res.json<{ blobKey: string }>();
    expect(uploaded).toMatchObject({
      filename: 'Q4 plan.json',
      contentType: 'application/json',
      sizeBytes: 12,
    });
    expect(uploaded.blobKey.startsWith('uploads/user-1/')).toBe(true);
    expect((await send({ ...message, attachments: [uploaded] })).statusCode).toBe(200);

    const download = (key: string, who = 'user-1') =>
      app.inject({
        url: `/mail/uploads/file?key=${encodeURIComponent(key)}&name=${encodeURIComponent('Q4 plan.json')}`,
        headers: as(who),
      });
    const file = await download(uploaded.blobKey);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('{"seats":20}');
    expect(file.headers['content-disposition']).toContain("filename*=UTF-8''Q4%20plan.json");
    // Someone else's file, or a path that tries to climb out, is not served.
    expect((await download(uploaded.blobKey, 'someone-else')).statusCode).toBe(404);
    expect((await download('uploads/user-1/../user-2/x')).statusCode).toBe(404);
  });

  it('forwards a stored attachment and suggests people the user has mailed', async () => {
    const forwarded = await app.inject({
      method: 'POST',
      url: '/mail/uploads/from-message',
      headers: as(),
      payload: { messageId: 'm1', index: 0 },
    });
    expect(forwarded.json()).toMatchObject({
      blobKey: 'attachments/user-1/abc',
      filename: 'file-0.pdf',
    });

    const contacts = await app.inject({ url: '/mail/contacts?q=pri', headers: as() });
    expect(contacts.json<{ items: unknown[] }>().items).toEqual([
      { name: 'Priya', address: 'priya@acme.example' },
    ]);
  });

  it('shares a file too big to attach from cloud storage, by link', async () => {
    const upload = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/mail/uploads/cloud',
        headers: {
          ...as(),
          'content-type': 'application/octet-stream',
          'x-filename': encodeURIComponent('big video.mp4'),
          'x-content-type': 'video/mp4',
          ...headers,
        },
        payload: Buffer.alloc(30 * 1024 * 1024),
      });
    const res = await upload({ 'x-storage-account': 'g1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'big video.mp4',
      link: 'https://drive.example/g1/big video.mp4',
      provider: 'GOOGLE_DRIVE',
      sizeBytes: 30 * 1024 * 1024,
    });
    expect((await upload({})).statusCode).toBe(400);
  });
});
