import {
  createJobEnvelope,
  historyPayloadSchema,
  ingestPayloadSchema,
  QUEUES,
  type HistoryPayload,
  type IngestPayload,
  type JobEnvelope,
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
import { createSupervisor, type Supervisor } from './supervisor';

const logger = createLogger({ service: 'test', level: 'silent' });
const user = { email: 'me@onebox.test', password: 'secret-pass' };

let mail: TestMailServer;
let redisContainer: TestRedis;
let redis: Redis;
let store: MailboxStore;
const jobs: JobEnvelope<IngestPayload>[] = [];
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

async function seenFlags() {
  const client = new ImapFlow({
    host: mail.host,
    port: mail.imapPort,
    secure: false,
    auth: { user: user.email, pass: user.password },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const result: Record<string, boolean> = {};
  for await (const message of client.fetch('1:*', { envelope: true, flags: true })) {
    result[message.envelope?.subject ?? ''] = message.flags?.has('\\Seen') ?? false;
  }
  lock.release();
  await client.logout();
  return result;
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
      store,
      allowPrivateHosts: true,
      initialBatch: 2,
      highWatermark: 1000,
      connectTimeoutMs: 5000,
    },
  });
  closers.push(instance.close, producer.close);
  return instance;
}

beforeAll(async () => {
  [mail, redisContainer] = await Promise.all([startGreenMail([user]), startRedis()]);
  redis = new Redis(redisContainer.url);
  store = createMailboxStore(redis);
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

const subjects = (backfill: boolean) =>
  jobs
    .filter((job) => job.payload.backfill === backfill)
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
    await vi.waitFor(async () =>
      expect(await store.getCounts('acc-1', 'INBOX')).toMatchObject({
        total: 3,
        unread: 3,
        userId: 'user-1',
      }),
    );
    expect(await store.getHistory('acc-1', 'INBOX')).toMatchObject({ status: 'idle' });
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
        expect(await store.getCounts('acc-1', 'INBOX')).toMatchObject({ total: 4, unread: 3 }),
      {
        timeout: 10_000,
      },
    );
  });

  it('fetches older mail on request and marks history complete once stored', async () => {
    const oldestFetched = Math.min(...jobs.map((job) => job.payload.uid));
    const uidValidity = jobs[0]!.payload.uidValidity;
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
        payload: { folder: 'INBOX', uidValidity, beforeUid: oldestFetched, count: 50 },
      }),
    );

    await vi.waitFor(
      async () =>
        expect(await store.getHistory('acc-1', 'INBOX')).toMatchObject({ status: 'complete' }),
      {
        timeout: 15_000,
      },
    );
    expect(subjects(true)).toContain('Old one');
    expect(jobs.filter((job) => subjects(true).length && job.payload.uid === 1)).toHaveLength(1);
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
