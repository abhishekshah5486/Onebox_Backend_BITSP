import {
  createJobEnvelope,
  encodeUidSet,
  ingestDedupeKey,
  type MailboxChangePayload,
} from '@onebox/contracts';
import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { createLogger } from '@onebox/logger';
import { startMongo, type TestMongo } from '@onebox/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes, mailCollections, type MailCollections } from '../db/collections';
import { createIngestHandler } from '../ingest/ingest-message';
import { ingestJob } from '../test/fixtures';
import { createChangesHandler, PENDING_GRACE_MS } from './apply-changes';

const logger = createLogger({ service: 'test', level: 'silent' });
const context = { logger, attempt: 1 };
const ACCOUNT = 'acc-sync';

let mongo: TestMongo;
let handle: MongoHandle;
let collections: MailCollections;
let ingest: ReturnType<typeof createIngestHandler>;
let apply: ReturnType<typeof createChangesHandler>;

beforeAll(async () => {
  mongo = await startMongo();
  handle = await connectMongo(mongo.uri, 'onebox_mail_sync_test');
  collections = mailCollections(handle.db);
  await ensureIndexes(collections);
  ingest = createIngestHandler(collections);
  apply = createChangesHandler(collections);
});

beforeEach(async () => {
  await collections.messages.deleteMany({});
  await collections.threads.deleteMany({});
});

afterAll(async () => {
  await handle.close();
  await mongo.stop();
});

const change = (payload: MailboxChangePayload) =>
  apply(createJobEnvelope({ jobId: 'c', userId: 'user-1', accountId: ACCOUNT, payload }), context);

const put = (subject: string, uid: number, extra: Parameters<typeof ingestJob>[0] = {}) =>
  ingest(
    ingestJob({ accountId: ACCOUNT, subject, messageId: `<${subject}@x>`, uid, ...extra }),
    context,
  );

const thread = (subject: string) => collections.threads.findOne({ subject });
const inbox = { folder: 'INBOX', uidValidity: 1 };

describe('mailbox changes', () => {
  it('follows a move to its new folder and uid', async () => {
    await put('Moved', 10);
    await change({
      type: 'moved',
      ...inbox,
      to: { folder: 'Archive', role: 'archive', uidValidity: 5 },
      uidMap: [[10, 77]],
      keepSource: false,
    });

    const [doc] = await collections.messages.find({ subject: 'Moved' }).toArray();
    expect(doc).toMatchObject({ folder: 'Archive', role: 'archive', uid: 77, uidValidity: 5 });
    expect(doc!._id).toBe(
      ingestDedupeKey({ accountId: ACCOUNT, folder: 'Archive', uidValidity: 5, uid: 77 }),
    );
    expect(await thread('Moved')).toMatchObject({ folders: ['archive'] });
  });

  it("keeps the source when copying out of gmail's all mail", async () => {
    await put('Copied', 11, { folder: { path: '[Gmail]/All Mail', role: 'archive' } });
    await change({
      type: 'moved',
      folder: '[Gmail]/All Mail',
      uidValidity: 1,
      to: { folder: 'Work', role: 'label', uidValidity: 3 },
      uidMap: [[11, 4]],
      keepSource: true,
    });
    expect(await thread('Copied')).toMatchObject({ folders: ['archive'], labels: ['Work'] });
  });

  it('drops mail gone from the server, applies flags and tabs, and ignores newer mail', async () => {
    await put('Stays', 1);
    await put('Deleted elsewhere', 2);
    await put('Arrived later', 9);
    await change({
      type: 'snapshot',
      ...inbox,
      role: 'inbox',
      uidNext: 5,
      present: encodeUidSet([1, 3]),
      flags: [{ uid: 1, flags: ['\\Seen', '\\Flagged'] }],
      categories: { promotions: '1' },
    });

    expect(await thread('Deleted elsewhere')).toBeNull();
    expect(await thread('Arrived later')).not.toBeNull();
    expect(await thread('Stays')).toMatchObject({
      unreadCount: 0,
      isStarred: true,
      category: 'promotions',
    });
  });

  it('protects changes still on their way to the server, then lets the server win', async () => {
    await put('Archiving', 1);
    await collections.messages.updateOne(
      { subject: 'Archiving' },
      {
        $set: {
          pendingSince: new Date(),
          isRead: true,
          movingTo: { role: 'archive', folder: null },
        },
      },
    );
    const snapshot = {
      type: 'snapshot' as const,
      ...inbox,
      role: 'inbox' as const,
      uidNext: 2,
      present: '1',
      flags: [{ uid: 1, flags: [] }],
    };
    await change(snapshot);
    expect(await collections.messages.findOne({ subject: 'Archiving' })).toMatchObject({
      isRead: true,
      movingTo: { role: 'archive' },
    });

    // The op never landed: once the grace period is over the server state returns.
    await collections.messages.updateOne(
      { subject: 'Archiving' },
      { $set: { pendingSince: new Date(Date.now() - PENDING_GRACE_MS - 1000) } },
    );
    await change(snapshot);
    expect(await collections.messages.findOne({ subject: 'Archiving' })).toMatchObject({
      isRead: false,
      movingTo: null,
      pendingSince: null,
    });
  });

  it('settles a failed move back to where the server has it', async () => {
    await put('Stuck', 1);
    await collections.messages.updateOne(
      { subject: 'Stuck' },
      { $set: { pendingSince: new Date(), movingTo: { role: 'trash', folder: null } } },
    );
    await change({ type: 'settled', ...inbox, uids: [1] });
    expect(await thread('Stuck')).toMatchObject({ folders: ['inbox'] });
  });

  it('forgets a renumbered folder and removed messages', async () => {
    await put('Old numbering', 1, { uidValidity: 7 });
    await put('Removed', 2);
    await change({ type: 'removed', ...inbox, uids: [2] });
    await change({ type: 'snapshot', ...inbox, role: 'inbox', uidNext: 2, present: '', flags: [] });
    expect(await collections.messages.countDocuments()).toBe(0);
    expect(await collections.threads.countDocuments()).toBe(0);
  });
});
