import { createHash } from 'node:crypto';
import {
  createJobEnvelope,
  MAX_INDEXED_BODY_CHARS,
  type IndexPayload,
  type SearchDocument,
} from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import type { Producer } from '@onebox/queue';
import type { ChangeStream, ChangeStreamDocument, Collection, Db, ResumeToken } from 'mongodb';
import { Timestamp } from 'mongodb';
import type { MessageDoc } from '../db/collections';

export const RESUME_KEY = 'search:feed:resume';
// Where the stream starts once the backfill is queued, until it has a resume token of its own.
export const START_KEY = 'search:feed:start';
// Kept while a backfill is under way, so a restart re-queues under the same job ids.
export const BACKFILL_KEY = 'search:feed:backfill';
const BACKFILL_BATCH = 500;
const RESTART_DELAY_MS = 5_000;
// Resume tokens the server no longer has (history rolled past them, or a malformed token).
const LOST_HISTORY = new Set([280, 286]);
// Changes search doesn't care about: bookkeeping while an action reaches the server.
const IGNORED_FIELDS = new Set(['pendingSince', 'movingTo', 'flags', 'unsubscribe']);
// Bodies are never needed for search and can be huge, so they're left out.
const WITHOUT_HTML = { htmlBody: 0 } as const;

type IndexedMessage = Omit<MessageDoc, 'htmlBody'>;
type CopyKey = Pick<MessageDoc, '_id' | 'userId' | 'accountId' | 'messageIdHeader'>;

const hash = (value: string) => createHash('sha1').update(value).digest('hex');

// One email, whichever folders hold a copy of it; a copy without a Message-ID stands alone.
export const searchKey = (copy: CopyKey) =>
  hash([copy.userId, copy.accountId, copy.messageIdHeader ?? `copy:${copy._id}`].join('\n'));

// A cluster time as one increasing number (ops within a second stay far below a million).
export const versionOf = (time: Timestamp) => time.high * 1_000_000 + time.low;

// The copies of one email, merged: content from the first, folders and flags from all.
export function toSearchDocument(copies: IndexedMessage[]): SearchDocument {
  const sorted = [...copies].sort((a, b) => a._id.localeCompare(b._id));
  const doc = sorted[0]!;
  return {
    key: searchKey(doc),
    copies: sorted.map((copy) => ({ messageId: copy._id, folder: copy.folder, role: copy.role })),
    userId: doc.userId,
    accountId: doc.accountId,
    threadId: doc.threadId,
    from: doc.from,
    to: doc.to,
    cc: doc.cc,
    subject: doc.subject,
    body: (doc.textBody || doc.snippet).slice(0, MAX_INDEXED_BODY_CHARS),
    attachmentNames: doc.attachments.filter((a) => !a.inline).map((a) => a.filename),
    labels: [...new Set(sorted.flatMap((copy) => copy.aiLabels ?? []))],
    categories: [...new Set(sorted.flatMap((copy) => copy.categories ?? []))],
    isRead: sorted.every((copy) => copy.isRead),
    isStarred: sorted.some((copy) => copy.isStarred),
    sizeBytes: doc.sizeBytes,
    receivedAt: doc.receivedAt.toISOString(),
  };
}

// The copy a change is about, if search cares: removed (by id) or changed (to rebuild from).
export function changedCopy(
  change: ChangeStreamDocument<IndexedMessage>,
): { removed: string } | { changed: IndexedMessage } | null {
  switch (change.operationType) {
    case 'delete':
      return { removed: change.documentKey._id };
    case 'update': {
      const touched = Object.keys(change.updateDescription.updatedFields ?? {});
      const removed = change.updateDescription.removedFields ?? [];
      const relevant = [...touched, ...removed].some((field) => !IGNORED_FIELDS.has(field));
      // No document means it was deleted since; that delete has its own event.
      return relevant && change.fullDocument ? { changed: change.fullDocument } : null;
    }
    case 'insert':
    case 'replace':
      return { changed: change.fullDocument };
    default:
      return null;
  }
}

// Where the resume point is kept (Redis).
export interface ResumeStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

// Keeps the search service's indexes in step with stored mail: every email once on first run,
// then each change, resuming after a restart from where it stopped.
export function startSearchFeed({
  db,
  messages,
  redis,
  queues,
  logger,
}: {
  db: Db;
  messages: Collection<MessageDoc>;
  redis: ResumeStore;
  queues: Pick<Producer<IndexPayload>, 'enqueue'>[];
  logger: Logger;
}) {
  let stream: ChangeStream<IndexedMessage> | null = null;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const send = async (jobId: string, userId: string, payload: IndexPayload) => {
    for (const queue of queues) {
      await queue.enqueue(createJobEnvelope({ jobId, userId, payload }));
    }
  };

  const copiesOf = (copy: CopyKey) =>
    messages
      .find(
        copy.messageIdHeader
          ? {
              userId: copy.userId,
              accountId: copy.accountId,
              messageIdHeader: copy.messageIdHeader,
            }
          : { _id: copy._id },
        { projection: WITHOUT_HTML },
      )
      .toArray() as Promise<IndexedMessage[]>;

  async function backfill(): Promise<Timestamp> {
    // Changes made while the backfill runs are picked up by the stream that starts here.
    // hello, unlike ping, reports the cluster time on Atlas too.
    const { operationTime } = (await db.command({ hello: 1 })) as { operationTime?: Timestamp };
    if (!operationTime) throw new Error('the database did not report its operation time');
    const version = versionOf(operationTime);
    const run = (await redis.get(BACKFILL_KEY)) ?? Date.now().toString(36);
    await redis.set(BACKFILL_KEY, run);

    let count = 0;
    let group: IndexedMessage[] = [];
    const flush = async () => {
      if (group.length === 0) return;
      const doc = toSearchDocument(group);
      await send(`backfill-${run}-${doc.key}`, doc.userId, { op: 'upsert', version, doc });
      count += 1;
      group = [];
    };
    // Sorted so the copies of one email arrive together and become one document.
    const cursor = messages
      .find({}, { projection: WITHOUT_HTML })
      .sort({ userId: 1, accountId: 1, messageIdHeader: 1 })
      .batchSize(BACKFILL_BATCH) as unknown as AsyncIterable<IndexedMessage>;
    for await (const copy of cursor) {
      if (closed) throw new Error('search feed closed during backfill');
      if (group[0] && searchKey(group[0]) !== searchKey(copy)) await flush();
      group.push(copy);
    }
    await flush();
    logger.info({ emails: count }, 'search backfill queued');
    // The stream's start is inclusive, and the backfill already covered that last write.
    const start = new Timestamp({ t: operationTime.high, i: operationTime.low + 1 });
    await redis.set(START_KEY, JSON.stringify({ t: start.high, i: start.low }));
    await redis.del(BACKFILL_KEY);
    return start;
  }

  async function startPoint() {
    const saved = await redis.get(RESUME_KEY);
    if (saved) return { resumeAfter: JSON.parse(saved) as ResumeToken };
    const at = await redis.get(START_KEY);
    if (at) {
      return { startAtOperationTime: new Timestamp(JSON.parse(at) as { t: number; i: number }) };
    }
    return { startAtOperationTime: await backfill() };
  }

  // The email as it stands now, so whichever job lands last carries the latest state.
  async function payloadOf(
    change: ChangeStreamDocument<IndexedMessage>,
  ): Promise<{ userId: string; payload: IndexPayload } | null> {
    const copy = changedCopy(change);
    if (!copy || !('clusterTime' in change) || !change.clusterTime) return null;
    const version = versionOf(change.clusterTime);
    // A removed copy's owner isn't in its event; search finds it by the copy's id.
    if ('removed' in copy) {
      return { userId: 'system', payload: { op: 'delete', version, messageId: copy.removed } };
    }
    const copies = await copiesOf(copy.changed);
    if (copies.length === 0) return null;
    const doc = toSearchDocument(copies);
    return { userId: doc.userId, payload: { op: 'upsert', version, doc } };
  }

  async function follow() {
    const start = await startPoint();
    if (closed) return;
    stream = messages.watch<IndexedMessage, ChangeStreamDocument<IndexedMessage>>(
      [
        { $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
        { $project: { 'fullDocument.htmlBody': 0 } },
      ],
      { fullDocument: 'updateLookup', ...start },
    );
    logger.info({ resumed: 'resumeAfter' in start }, 'search feed started');
    for await (const change of stream) {
      const job = await payloadOf(change);
      if (job) {
        const token = (change._id as { _data: string })._data;
        await send(`change-${hash(token)}`, job.userId, job.payload);
      }
      await redis.set(RESUME_KEY, JSON.stringify(change._id));
    }
    if (!closed) throw new Error('search feed ended');
  }

  const run = () => {
    follow().catch(async (err: unknown) => {
      if (closed) return;
      const code = (err as { code?: number }).code;
      if (code !== undefined && LOST_HISTORY.has(code)) {
        logger.warn({ code }, 'search feed history lost, indexing everything again');
        for (const key of [RESUME_KEY, START_KEY, BACKFILL_KEY]) await redis.del(key);
      } else {
        logger.warn({ err: (err as Error).message }, 'search feed interrupted, reopening');
      }
      await stream?.close().catch(() => {});
      if (!closed) timer = setTimeout(run, RESTART_DELAY_MS);
    });
  };
  run();

  return {
    close: async () => {
      closed = true;
      clearTimeout(timer);
      await stream?.close();
    },
  };
}
