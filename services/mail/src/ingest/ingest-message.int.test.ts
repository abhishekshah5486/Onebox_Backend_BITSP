import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { createLogger } from '@onebox/logger';
import { startMongo, type TestMongo } from '@onebox/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes, mailCollections, type MailCollections } from '../db/collections';
import { ingestJob } from '../test/fixtures';
import { backfillThreadSortKeys } from '../threads/thread-store';
import { createIngestHandler } from './ingest-message';

const context = { logger: createLogger({ service: 'test', level: 'silent' }), attempt: 1 };

let mongo: TestMongo;
let handle: MongoHandle;
let collections: MailCollections;
let ingest: ReturnType<typeof createIngestHandler>;

beforeAll(async () => {
  mongo = await startMongo();
  handle = await connectMongo(mongo.uri, 'onebox_mail_test');
  collections = mailCollections(handle.db);
  await ensureIndexes(collections);
  ingest = createIngestHandler(collections);
});

beforeEach(async () => {
  await collections.messages.deleteMany({});
  await collections.threads.deleteMany({});
});

afterAll(async () => {
  await handle.close();
  await mongo.stop();
});

const threadOf = async (messageId: string) =>
  (await collections.messages.findOne({ messageIdHeader: messageId }))!.threadId;

describe('ingest handler', () => {
  it('stores a message and creates its thread', async () => {
    const job = ingestJob({ subject: 'Demo?', messageId: '<m1@x>', flags: ['\\Seen'] });
    await ingest(job, context);

    const message = await collections.messages.findOne({ _id: job.jobId });
    expect(message).toMatchObject({
      subject: 'Demo?',
      isRead: true,
      from: { address: 'priya@acme.example' },
    });
    const thread = await collections.threads.findOne({ _id: message!.threadId });
    expect(thread).toMatchObject({
      subject: 'Demo?',
      messageCount: 1,
      unreadCount: 0,
      userId: 'user-1',
    });
  });

  it('is idempotent when the same job runs twice', async () => {
    const job = ingestJob({ messageId: '<dup@x>' });
    await ingest(job, context);
    await ingest(job, context);

    expect(await collections.messages.countDocuments()).toBe(1);
    expect(await collections.threads.findOne({})).toMatchObject({
      messageCount: 1,
      unreadCount: 1,
    });
  });

  it('threads replies through In-Reply-To and keeps counts right', async () => {
    await ingest(
      ingestJob({
        subject: 'Pricing',
        messageId: '<p1@x>',
        date: 'Tue, 06 Oct 2026 10:00:00 +0000',
      }),
      context,
    );
    await ingest(
      ingestJob({
        subject: 'Re: Pricing',
        messageId: '<p2@x>',
        inReplyTo: '<p1@x>',
        from: 'Me <me@gmail.com>',
        flags: ['\\Seen'],
        date: 'Tue, 06 Oct 2026 11:00:00 +0000',
        body: 'Here are the prices',
      }),
      context,
    );

    expect(await threadOf('<p2@x>')).toBe(await threadOf('<p1@x>'));
    const thread = await collections.threads.findOne({ _id: await threadOf('<p1@x>') });
    expect(thread).toMatchObject({
      subject: 'Pricing',
      messageCount: 2,
      unreadCount: 1,
      snippet: 'Here are the prices',
      lastFrom: { address: 'me@gmail.com' },
    });
    expect(thread!.lastMessageAt.toISOString()).toBe('2026-10-06T11:00:00.000Z');
    expect(thread!.participants.map((p) => p.address).sort()).toEqual([
      'me@gmail.com',
      'priya@acme.example',
    ]);
  });

  it('joins a parent that arrives after its reply', async () => {
    await ingest(
      ingestJob({ subject: 'Re: Late', messageId: '<l2@x>', references: '<l1@x>' }),
      context,
    );
    await ingest(ingestJob({ subject: 'Late', messageId: '<l1@x>' }), context);

    expect(await threadOf('<l1@x>')).toBe(await threadOf('<l2@x>'));
    expect(await collections.threads.countDocuments()).toBe(1);
  });

  it('threads related messages correctly even when they are ingested concurrently', async () => {
    for (let i = 0; i < 15; i++) {
      await Promise.all([
        ingest(ingestJob({ subject: `Race ${i}`, messageId: `<race-${i}-a@x>` }), context),
        ingest(
          ingestJob({
            subject: `Re: Race ${i}`,
            messageId: `<race-${i}-b@x>`,
            inReplyTo: `<race-${i}-a@x>`,
          }),
          context,
        ),
        ingest(
          ingestJob({
            subject: `Re: Race ${i}`,
            messageId: `<race-${i}-c@x>`,
            references: `<race-${i}-a@x> <race-${i}-b@x>`,
          }),
          context,
        ),
      ]);
      const ids = await Promise.all(['a', 'b', 'c'].map((s) => threadOf(`<race-${i}-${s}@x>`)));
      expect(new Set(ids).size, `race ${i}`).toBe(1);
    }
    const threads = await collections.threads.find({ normalizedSubject: /^race / }).toArray();
    expect(threads).toHaveLength(15);
    expect(threads.every((thread) => thread.messageCount === 3)).toBe(true);
  });

  it('falls back to the subject only for replies', async () => {
    await ingest(ingestJob({ subject: 'Weekly sync', messageId: '<w1@x>' }), context);
    await ingest(ingestJob({ subject: 'RE: Weekly sync', messageId: '<w2@x>' }), context);
    await ingest(ingestJob({ subject: 'Weekly sync', messageId: '<w3@x>' }), context);

    expect(await threadOf('<w2@x>')).toBe(await threadOf('<w1@x>'));
    expect(await threadOf('<w3@x>')).not.toBe(await threadOf('<w1@x>'));
  });

  it('never merges threads across accounts', async () => {
    await ingest(ingestJob({ accountId: 'acc-1', subject: 'Hi', messageId: '<a1@x>' }), context);
    await ingest(
      ingestJob({
        accountId: 'acc-2',
        subject: 'Re: Hi',
        messageId: '<a2@x>',
        inReplyTo: '<a1@x>',
      }),
      context,
    );
    expect(await threadOf('<a2@x>')).not.toBe(await threadOf('<a1@x>'));
  });

  it('backfills the sort key on conversations stored before it existed', async () => {
    const job = ingestJob({ uid: 42, messageId: '<old@x>' });
    await ingest(job, context);
    await collections.threads.updateMany({}, { $unset: { lastUid: '' } });

    expect(await backfillThreadSortKeys(collections)).toBe(1);
    expect(await collections.threads.findOne({})).toMatchObject({ lastUid: 42 });
    expect(await backfillThreadSortKeys(collections)).toBe(0);
  });

  it('rejects jobs without an account as non-retryable', async () => {
    const { accountId: _accountId, ...withoutAccount } = ingestJob({});
    await expect(ingest(withoutAccount, context)).rejects.toMatchObject({ retryable: false });
  });
});
