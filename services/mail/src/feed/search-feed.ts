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
const BACKFILL_BATCH = 500;
const RESTART_DELAY_MS = 5_000;
// Resume tokens the server no longer has (history rolled past them, or a malformed token).
const LOST_HISTORY = new Set([280, 286]);
// Changes search doesn't care about: bookkeeping while an action reaches the server.
const IGNORED_FIELDS = new Set(['pendingSince', 'movingTo', 'flags', 'unsubscribe']);
// Bodies are never needed for search and can be huge, so they're left out of the stream.
const WITHOUT_HTML = { 'fullDocument.htmlBody': 0 } as const;

type IndexedMessage = Omit<MessageDoc, 'htmlBody'>;

export function toSearchDocument(doc: IndexedMessage): SearchDocument {
  const labels = new Set(doc.aiLabels ?? []);
  if (doc.role === 'label') labels.add(doc.folder);
  return {
    messageId: doc._id,
    userId: doc.userId,
    accountId: doc.accountId,
    threadId: doc.threadId,
    folder: doc.folder,
    role: doc.role,
    from: doc.from,
    to: doc.to,
    cc: doc.cc,
    subject: doc.subject,
    body: (doc.textBody || doc.snippet).slice(0, MAX_INDEXED_BODY_CHARS),
    attachmentNames: doc.attachments.filter((a) => !a.inline).map((a) => a.filename),
    labels: [...labels],
    categories: doc.categories ?? [],
    isRead: doc.isRead,
    isStarred: doc.isStarred,
    sizeBytes: doc.sizeBytes,
    receivedAt: doc.receivedAt.toISOString(),
  };
}

// What a change means for search: index the message again, drop it, or nothing.
export function indexPayloadOf(change: ChangeStreamDocument<IndexedMessage>): IndexPayload | null {
  switch (change.operationType) {
    case 'delete':
      return { op: 'delete', messageId: change.documentKey._id };
    case 'update': {
      const touched = Object.keys(change.updateDescription.updatedFields ?? {});
      const removed = change.updateDescription.removedFields ?? [];
      const relevant = [...touched, ...removed].some((field) => !IGNORED_FIELDS.has(field));
      if (!relevant || !change.fullDocument) return null;
      return { op: 'upsert', doc: toSearchDocument(change.fullDocument) };
    }
    case 'insert':
    case 'replace':
      return { op: 'upsert', doc: toSearchDocument(change.fullDocument) };
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

const hash = (value: string) => createHash('sha1').update(value).digest('hex');

// Keeps the search service's indexes in step with stored mail: every message once on first run,
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

  async function backfill(): Promise<Timestamp> {
    // Changes made while the backfill runs are picked up by the stream that starts here.
    const { operationTime } = (await db.command({ ping: 1 })) as { operationTime: Timestamp };
    const run = Date.now().toString(36);
    let count = 0;
    const cursor = messages
      .find({}, { projection: { htmlBody: 0 } })
      .batchSize(BACKFILL_BATCH) as unknown as AsyncIterable<IndexedMessage>;
    for await (const doc of cursor) {
      if (closed) break;
      await send(`backfill-${run}-${hash(doc._id)}`, doc.userId, {
        op: 'upsert',
        doc: toSearchDocument(doc),
      });
      count += 1;
    }
    logger.info({ messages: count }, 'search backfill queued');
    // The stream's start is inclusive, and the backfill already covered that last write.
    return new Timestamp({ t: operationTime.high, i: operationTime.low + 1 });
  }

  async function follow() {
    const saved = await redis.get(RESUME_KEY);
    const start = saved
      ? { resumeAfter: JSON.parse(saved) as ResumeToken }
      : { startAtOperationTime: await backfill() };
    if (closed) return;
    stream = messages.watch<IndexedMessage, ChangeStreamDocument<IndexedMessage>>(
      [
        { $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
        { $project: WITHOUT_HTML },
      ],
      { fullDocument: 'updateLookup', ...start },
    );
    logger.info({ resumed: Boolean(saved) }, 'search feed started');
    for await (const change of stream) {
      const payload = indexPayloadOf(change);
      if (payload) {
        // Deleted mail carries no owner in its change event; search deletes by message id alone.
        const userId = payload.op === 'upsert' ? payload.doc.userId : 'system';
        const token = (change._id as { _data: string })._data;
        await send(`change-${hash(token)}`, userId, payload);
      }
      await redis.set(RESUME_KEY, JSON.stringify(change._id));
    }
    if (!closed) throw new Error('search feed ended');
  }

  const run = () => {
    follow().catch(async (err: unknown) => {
      const code = (err as { code?: number }).code;
      if (code !== undefined && LOST_HISTORY.has(code)) {
        logger.warn({ code }, 'search feed history lost, indexing everything again');
        await redis.del(RESUME_KEY);
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
