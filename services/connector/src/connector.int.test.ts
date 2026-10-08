import {
  createJobEnvelope,
  decodeUidSet,
  historyPayloadSchema,
  ingestPayloadSchema,
  mailboxChangePayloadSchema,
  mailboxOpPayloadSchema,
  QUEUES,
  type HistoryPayload,
  type IngestPayload,
  type JobEnvelope,
  type MailboxChangePayload,
  type MailboxOpPayload,
} from '@onebox/contracts';
import { createLogger } from '@onebox/logger';
import { createMailboxStore, type MailboxStore } from '@onebox/mailbox-state';
import { createConsumer, createProducer } from '@onebox/queue';
import { startGreenMail, startRedis, type TestMailServer, type TestRedis } from '@onebox/testing';
import { ImapFlow } from 'imapflow';
import { Redis } from 'ioredis';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHistoryHandler } from './history';
import type { ActiveAccount, InternalClient, ReportedStatus } from './internal-client';
import { createOpsHandler } from './ops';
import { createSupervisor, type Supervisor } from './supervisor';

const logger = createLogger({ service: 'test', level: 'silent' });
const user = { email: 'me@onebox.test', password: 'secret-pass' };

let mail: TestMailServer;
let redisContainer: TestRedis;
let redis: Redis;
let store: MailboxStore;
const jobs: JobEnvelope<IngestPayload>[] = [];
const changes: MailboxChangePayload[] = [];
let changeProducer: ReturnType<typeof createProducer<MailboxChangePayload>>;
let opProducer: ReturnType<typeof createProducer<MailboxOpPayload>>;
const statuses: { accountId: string; status: ReportedStatus }[] = [];
const closers: (() => Promise<unknown>)[] = [];

const account: ActiveAccount = {
  id: 'acc-1',
  userId: 'user-1',
  provider: 'IMAP',
  emailAddress: user.email,
  status: 'CONNECTED',
  updatedAt: new Date().toISOString(),
  syncState: {},
};

function fakeInternal(password = user.password, accounts = [account]): InternalClient {
  return {
    listAccounts: async () => accounts,
    getCredentials: async () => ({
      host: mail.host,
      port: mail.imapPort,
      tls: false,
      username: user.email,
      password,
      userId: account.userId,
    }),
    saveSyncState: async (accountId, folder, state) => {
      const target = accounts.find((a) => a.id === accountId)!;
      target.syncState = { ...target.syncState, [folder]: state };
    },
    reportStatus: async (accountId, status) => {
      statuses.push({ accountId, status });
    },
    getPreferences: async () => ({ markSeenOnFetch: true }),
  };
}

async function send(subject: string) {
  const transport = nodemailer.createTransport({
    host: mail.host,
    port: mail.smtpPort,
    secure: false,
    ignoreTLS: true,
  });
  await transport.sendMail({
    from: 'priya@acme.example',
    to: user.email,
    subject,
    text: `Body of ${subject}`,
  });
}

async function imap() {
  const client = new ImapFlow({
    host: mail.host,
    port: mail.imapPort,
    secure: false,
    auth: { user: user.email, pass: user.password },
    logger: false,
  });
  await client.connect();
  return client;
}

async function appendTo(path: string, subject: string) {
  const client = await imap();
  if (!(await client.list()).some((entry) => entry.path === path)) await client.mailboxCreate(path);
  await client.append(
    path,
    `From: ${user.email}\r\nTo: priya@acme.example\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@onebox.test>\r\n\r\nBody of ${subject}\r\n`,
    ['\\Seen'],
  );
  await client.logout();
}

async function seenFlags() {
  const client = await imap();
  const lock = await client.getMailboxLock('INBOX');
  const result: Record<string, boolean> = {};
  for await (const message of client.fetch('1:*', { envelope: true, flags: true })) {
    result[message.envelope?.subject ?? ''] = message.flags?.has('\\Seen') ?? false;
  }
  lock.release();
  await client.logout();
  return result;
}

async function serverState(path: string) {
  const client = await imap();
  const lock = await client.getMailboxLock(path);
  const result: Record<string, { uid: number; flags: Set<string> }> = {};
  const uidValidity = Number(client.mailbox && client.mailbox.uidValidity);
  if (client.mailbox && client.mailbox.exists > 0) {
    for await (const message of client.fetch('1:*', { envelope: true, flags: true, uid: true })) {
      result[message.envelope?.subject ?? ''] = {
        uid: message.uid,
        flags: message.flags ?? new Set(),
      };
    }
  }
  lock.release();
  await client.logout();
  return { uidValidity, messages: result };
}

async function runOp(payload: MailboxOpPayload) {
  await opProducer.enqueue(
    createJobEnvelope({
      jobId: `op-${Math.random()}`,
      userId: 'user-1',
      accountId: 'acc-1',
      payload,
    }),
  );
}

function supervisor(internal: InternalClient): Supervisor {
  const producer = createProducer<IngestPayload>(QUEUES.ingest, {
    redisUrl: redisContainer.url,
    logger,
  });
  const instance = createSupervisor({
    internal,
    redis,
    logger,
    ownerId: `test-${Math.random()}`,
    reconcileIntervalMs: 60_000,
    leaseTtlMs: 3000,
    sessionDeps: {
      producer,
      changes: changeProducer,
      store,
      allowPrivateHosts: true,
      initialBatch: 2,
      highWatermark: 1000,
      connectTimeoutMs: 5000,
      folderSyncIntervalMs: 500,
    },
  });
  closers.push(instance.close, producer.close);
  return instance;
}

beforeAll(async () => {
  [mail, redisContainer] = await Promise.all([startGreenMail([user]), startRedis()]);
  redis = new Redis(redisContainer.url);
  store = createMailboxStore(redis);
  changeProducer = createProducer<MailboxChangePayload>(QUEUES.mailboxChanges, {
    redisUrl: redisContainer.url,
    logger,
  });
  opProducer = createProducer<MailboxOpPayload>(QUEUES.mailboxOps, {
    redisUrl: redisContainer.url,
    logger,
  });
  const changeConsumer = createConsumer(
    QUEUES.mailboxChanges,
    mailboxChangePayloadSchema,
    async (envelope) => {
      changes.push(envelope.payload);
    },
    { redisUrl: redisContainer.url, logger, concurrency: 1 },
  );
  const ops = createConsumer(
    QUEUES.mailboxOps,
    mailboxOpPayloadSchema,
    createOpsHandler({
      internal: fakeInternal(),
      changes: changeProducer,
      allowPrivateHosts: true,
      connectTimeoutMs: 5000,
      maxAttempts: 1,
    }),
    { redisUrl: redisContainer.url, logger, concurrency: 1 },
  );
  closers.push(changeConsumer.close, ops.close, changeProducer.close, opProducer.close);
  const historyProducer = createProducer<IngestPayload>(QUEUES.ingest, {
    redisUrl: redisContainer.url,
    logger,
  });
  const history = createConsumer(
    QUEUES.history,
    historyPayloadSchema,
    createHistoryHandler({
      internal: fakeInternal(),
      store,
      producer: historyProducer,
      allowPrivateHosts: true,
      connectTimeoutMs: 5000,
    }),
    { redisUrl: redisContainer.url, logger },
  );
  closers.push(history.close, historyProducer.close);
  const consumer = createConsumer(
    QUEUES.ingest,
    ingestPayloadSchema,
    async (envelope) => {
      jobs.push(envelope);
    },
    { redisUrl: redisContainer.url, logger },
  );
  closers.push(consumer.close);
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  redis.disconnect();
  await Promise.all([mail.stop(), redisContainer.stop()]);
});

const subjects = (backfill: boolean, role = 'inbox') =>
  jobs
    .filter((job) => job.payload.backfill === backfill && job.payload.role === role)
    .map(
      (job) =>
        Buffer.from(job.payload.rawSource, 'base64')
          .toString()
          .match(/^Subject: (.*)$/m)?.[1],
    );

describe('imap connector', () => {
  let first: Supervisor;

  it('fetches only the newest messages first and publishes server counts', async () => {
    await send('Old one');
    await send('Old two');
    await send('Old three');

    first = supervisor(fakeInternal());
    await first.reconcile();

    await vi.waitFor(() => expect(subjects(true).sort()).toEqual(['Old three', 'Old two']), {
      timeout: 15_000,
    });
    expect(await seenFlags()).toEqual({ 'Old one': false, 'Old two': false, 'Old three': false });
    expect(jobs.every((job) => job.payload.role === 'inbox')).toBe(true);
    await vi.waitFor(async () =>
      expect(await store.getCounts('acc-1', 'inbox')).toMatchObject({
        total: 3,
        unread: 3,
        userId: 'user-1',
      }),
    );
    expect(await store.getHistory('acc-1', 'inbox')).toMatchObject({ status: 'idle' });
    expect(statuses).toContainEqual({ accountId: 'acc-1', status: 'CONNECTED' });
  });

  it('picks up new mail through IDLE, applies mark-as-read and refreshes counts', async () => {
    await send('Fresh news');

    await vi.waitFor(() => expect(subjects(false)).toEqual(['Fresh news']), { timeout: 15_000 });
    await vi.waitFor(async () => expect((await seenFlags())['Fresh news']).toBe(true), {
      timeout: 5000,
    });
    expect((await seenFlags())['Old two']).toBe(false);
    await vi.waitFor(
      async () =>
        expect(await store.getCounts('acc-1', 'inbox')).toMatchObject({ total: 4, unread: 3 }),
      {
        timeout: 10_000,
      },
    );
  });

  it('syncs the sent folder on its own connection, newest first and then new mail', async () => {
    await appendTo('Sent', 'Sent one');
    await appendTo('Sent', 'Sent two');

    await vi.waitFor(
      () => expect(subjects(true, 'sent').sort()).toEqual(['Sent one', 'Sent two']),
      {
        timeout: 15_000,
      },
    );
    await vi.waitFor(async () =>
      expect(await store.getCounts('acc-1', 'sent')).toMatchObject({
        folder: 'Sent',
        total: 2,
        unread: 0,
      }),
    );

    await appendTo('Sent', 'Sent three');
    await vi.waitFor(() => expect(subjects(false, 'sent')).toEqual(['Sent three']), {
      timeout: 15_000,
    });
    expect(subjects(false)).toEqual(['Fresh news']);
  });

  it('fetches older mail on request and marks history complete once stored', async () => {
    const inbox = jobs.filter((job) => job.payload.role === 'inbox');
    const oldestFetched = Math.min(...inbox.map((job) => job.payload.uid));
    const uidValidity = inbox[0]!.payload.uidValidity;
    const producer = createProducer<HistoryPayload>(QUEUES.history, {
      redisUrl: redisContainer.url,
      logger,
    });
    closers.push(producer.close);

    await producer.enqueue(
      createJobEnvelope({
        jobId: `history-${oldestFetched}`,
        userId: 'user-1',
        accountId: 'acc-1',
        payload: {
          folder: 'INBOX',
          role: 'inbox',
          uidValidity,
          beforeUid: oldestFetched,
          count: 50,
        },
      }),
    );

    await vi.waitFor(
      async () =>
        expect(await store.getHistory('acc-1', 'inbox')).toMatchObject({ status: 'complete' }),
      {
        timeout: 15_000,
      },
    );
    expect(subjects(true)).toContain('Old one');
    expect(
      jobs.filter((job) => job.payload.role === 'inbox' && job.payload.uid === 1),
    ).toHaveLength(1);
  });

  it('syncs the archive folder and labels, and lists the labels', async () => {
    await appendTo('Archive', 'Archived one');
    await appendTo('Receipts', 'Receipt one');

    await vi.waitFor(
      () => {
        expect(subjects(true, 'archive')).toEqual(['Archived one']);
        expect(subjects(true, 'label')).toEqual(['Receipt one']);
      },
      { timeout: 15_000 },
    );
    expect(await store.getLabels('acc-1')).toEqual([{ path: 'Receipts', name: 'Receipts' }]);
    await vi.waitFor(async () =>
      expect(await store.getCounts('acc-1', 'label:Receipts')).toMatchObject({ total: 1 }),
    );
  });

  it('reports deletions and flag changes made in another mail app', async () => {
    const before = await serverState('INBOX');
    const flagged = before.messages['Old one']!.uid;
    const gone = before.messages['Old two']!.uid;
    const client = await imap();
    const lock = await client.getMailboxLock('INBOX');
    await client.messageFlagsAdd(String(flagged), ['\\Flagged'], { uid: true });
    await client.messageDelete(String(gone), { uid: true });
    lock.release();
    await client.logout();

    await vi.waitFor(
      () => {
        const inbox = changes.filter(
          (change) => change.type === 'snapshot' && change.folder === 'INBOX',
        );
        const latest = inbox.at(-1);
        expect(latest?.type === 'snapshot' && decodeUidSet(latest.present).has(gone)).toBe(false);
        const sawFlag = changes.some(
          (change) =>
            (change.type === 'flags' || change.type === 'snapshot') &&
            change.folder === 'INBOX' &&
            change.flags.some((f) => f.uid === flagged && f.flags.includes('\\Flagged')),
        );
        expect(sawFlag).toBe(true);
      },
      { timeout: 15_000 },
    );
  });

  it('applies flag changes, moves and permanent deletions to the server', async () => {
    const inbox = await serverState('INBOX');
    const fresh = inbox.messages['Fresh news']!.uid;
    const old = inbox.messages['Old three']!.uid;
    const base = { folder: 'INBOX', uidValidity: inbox.uidValidity };

    await runOp({
      ...base,
      uids: [fresh],
      op: { type: 'flags', add: ['\\Flagged'], remove: ['\\Seen'] },
    });
    await vi.waitFor(async () => {
      const flags = (await serverState('INBOX')).messages['Fresh news']!.flags;
      expect(flags.has('\\Flagged')).toBe(true);
      expect(flags.has('\\Seen')).toBe(false);
    });
    expect(changes).toContainEqual({ type: 'settled', ...base, uids: [fresh] });

    await runOp({ ...base, uids: [old], op: { type: 'move', to: { role: 'archive' } } });
    await vi.waitFor(async () => {
      expect((await serverState('INBOX')).messages['Old three']).toBeUndefined();
      expect((await serverState('Archive')).messages['Old three']).toBeDefined();
    });
    const archive = await serverState('Archive');
    const archivedUid = archive.messages['Old three']!.uid;
    await vi.waitFor(() =>
      expect(changes).toContainEqual({
        type: 'moved',
        ...base,
        to: { folder: 'Archive', role: 'archive', uidValidity: archive.uidValidity },
        uidMap: [[old, archivedUid]],
        keepSource: false,
      }),
    );

    await runOp({ ...base, uids: [fresh], op: { type: 'move', to: { label: 'Receipts' } } });
    await vi.waitFor(async () =>
      expect((await serverState('Receipts')).messages['Fresh news']).toBeDefined(),
    );
    // The label's next sync sees it as new mail there; the mail service dedupes it by key.
    await vi.waitFor(() => expect(subjects(false, 'label')).toEqual(['Fresh news']), {
      timeout: 15_000,
    });

    await runOp({
      ...base,
      uids: [inbox.messages['Old one']!.uid],
      op: { type: 'move', to: { role: 'trash' } },
    });
    await vi.waitFor(async () =>
      expect((await serverState('Trash')).messages['Old one']).toBeDefined(),
    );
    // A folder created on first use is then synced like any other.
    await vi.waitFor(() => expect(subjects(true, 'trash')).toEqual(['Old one']), {
      timeout: 15_000,
    });

    await runOp({
      folder: 'Archive',
      uidValidity: archive.uidValidity,
      uids: [archivedUid],
      op: { type: 'expunge' },
    });
    await vi.waitFor(async () =>
      expect((await serverState('Archive')).messages['Old three']).toBeUndefined(),
    );
    expect(changes).toContainEqual({
      type: 'removed',
      folder: 'Archive',
      uidValidity: archive.uidValidity,
      uids: [archivedUid],
    });
  });

  it('resumes from the cursor after a restart without duplicating work', async () => {
    await first.close();
    const before = jobs.length;

    const second = supervisor(fakeInternal());
    await second.reconcile();
    await vi.waitFor(() => expect(second.running()).toEqual(['acc-1']));
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(jobs.length).toBe(before);
    await second.close();
  });

  it('marks the account AUTH_FAILED and stops when the password is rejected', async () => {
    const broken = supervisor(fakeInternal('wrong-password'));
    await broken.reconcile();

    await vi.waitFor(
      () => expect(statuses.at(-1)).toEqual({ accountId: 'acc-1', status: 'AUTH_FAILED' }),
      {
        timeout: 15_000,
      },
    );
    await vi.waitFor(() => expect(broken.running()).toEqual([]));
  });
});
