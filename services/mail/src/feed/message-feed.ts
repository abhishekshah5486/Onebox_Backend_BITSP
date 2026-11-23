import { createHash } from 'node:crypto';
import type { Logger } from '@onebox/logger';
import type { ChangeStream, ChangeStreamDocument, Collection, Db, ResumeToken } from 'mongodb';
import { Timestamp } from 'mongodb';
import type { MessageDoc } from '../db/collections';

const BACKFILL_BATCH = 500;
const RESTART_DELAY_MS = 5_000;
// Resume tokens the server no longer has (history rolled past them, or a malformed token).
const LOST_HISTORY = new Set([280, 286]);
// Bodies can be huge and only some consumers need them; they read them on demand.
const WITHOUT_HTML = { htmlBody: 0 } as const;

export type FeedMessage = Omit<MessageDoc, 'htmlBody'>;
type CopyKey = Pick<MessageDoc, '_id' | 'userId' | 'accountId' | 'messageIdHeader'>;

export const hash = (value: string) => createHash('sha1').update(value).digest('hex');

// One email, whichever folders hold a copy of it; a copy without a Message-ID stands alone.
export const emailKey = (copy: CopyKey) =>
  hash([copy.userId, copy.accountId, copy.messageIdHeader ?? `copy:${copy._id}`].join('\n'));

// A cluster time as one increasing number (ops within a second stay far below a million).
export const versionOf = (time: Timestamp) => time.high * 1_000_000 + time.low;

// What a consumer is told: every copy of an email as it stands now, or a copy that is gone.
export type FeedEvent =
  | { kind: 'email'; version: number; copies: FeedMessage[] }
  | { kind: 'removed'; version: number; messageId: string };

export const feedKeys = (name: string) => ({
  resume: `${name}:feed:resume`,
  // Where the stream starts once the backfill is queued, until it has a resume token of its own.
  start: `${name}:feed:start`,
  // Kept while a backfill is under way, so a restart re-queues under the same job ids.
  backfill: `${name}:feed:backfill`,
});

// The copy a change is about, if the consumer cares: removed (by id) or changed (to rebuild from).
export function changedCopy(
  change: ChangeStreamDocument<FeedMessage>,
  ignored: ReadonlySet<string>,
): { removed: string } | { changed: FeedMessage } | null {
  switch (change.operationType) {
    case 'delete':
      return { removed: change.documentKey._id };
    case 'update': {
      const touched = Object.keys(change.updateDescription.updatedFields ?? {});
      const removed = change.updateDescription.removedFields ?? [];
      const relevant = [...touched, ...removed].some((field) => !ignored.has(field));
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

// Keeps one consumer in step with stored mail: every email once on first run, then each change,
// resuming after a restart from where it stopped. `send` gets a deterministic job id per event.
export function startMessageFeed({
  name,
  db,
  messages,
  redis,
  logger,
  ignoredFields,
  send,
}: {
  name: string;
  db: Db;
  messages: Collection<MessageDoc>;
  redis: ResumeStore;
  logger: Logger;
  ignoredFields: ReadonlySet<string>;
  send: (jobId: string, event: FeedEvent) => Promise<void>;
}) {
  const keys = feedKeys(name);
  let stream: ChangeStream<FeedMessage> | null = null;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

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
      .toArray() as Promise<FeedMessage[]>;

  async function backfill(): Promise<Timestamp> {
    // Changes made while the backfill runs are picked up by the stream that starts here.
    // hello, unlike ping, reports the cluster time on Atlas too.
    const { operationTime } = (await db.command({ hello: 1 })) as { operationTime?: Timestamp };
    if (!operationTime) throw new Error('the database did not report its operation time');
    const version = versionOf(operationTime);
    const run = (await redis.get(keys.backfill)) ?? Date.now().toString(36);
    await redis.set(keys.backfill, run);

    let count = 0;
    let group: FeedMessage[] = [];
    const flush = async () => {
      if (group.length === 0) return;
      await send(`backfill-${run}-${emailKey(group[0]!)}`, {
        kind: 'email',
        version,
        copies: group,
      });
      count += 1;
      group = [];
    };
    // Sorted so the copies of one email arrive together and become one event.
    const cursor = messages
      .find({}, { projection: WITHOUT_HTML })
      .sort({ userId: 1, accountId: 1, messageIdHeader: 1 })
      .batchSize(BACKFILL_BATCH) as unknown as AsyncIterable<FeedMessage>;
    for await (const copy of cursor) {
      if (closed) throw new Error(`${name} feed closed during backfill`);
      if (group[0] && emailKey(group[0]) !== emailKey(copy)) await flush();
      group.push(copy);
    }
    await flush();
    logger.info({ feed: name, emails: count }, 'feed backfill queued');
    // The stream's start is inclusive, and the backfill already covered that last write.
    const start = new Timestamp({ t: operationTime.high, i: operationTime.low + 1 });
    await redis.set(keys.start, JSON.stringify({ t: start.high, i: start.low }));
    await redis.del(keys.backfill);
    return start;
  }

  async function startPoint() {
    const saved = await redis.get(keys.resume);
    if (saved) return { resumeAfter: JSON.parse(saved) as ResumeToken };
    const at = await redis.get(keys.start);
    if (at) {
      return { startAtOperationTime: new Timestamp(JSON.parse(at) as { t: number; i: number }) };
    }
    return { startAtOperationTime: await backfill() };
  }

  // The email as it stands now, so whichever job lands last carries the latest state.
  async function eventOf(change: ChangeStreamDocument<FeedMessage>): Promise<FeedEvent | null> {
    const copy = changedCopy(change, ignoredFields);
    if (!copy || !('clusterTime' in change) || !change.clusterTime) return null;
    const version = versionOf(change.clusterTime);
    if ('removed' in copy) return { kind: 'removed', version, messageId: copy.removed };
    const copies = await copiesOf(copy.changed);
    return copies.length === 0 ? null : { kind: 'email', version, copies };
  }

  async function follow() {
    const start = await startPoint();
    if (closed) return;
    stream = messages.watch<FeedMessage, ChangeStreamDocument<FeedMessage>>(
      [
        { $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
        { $project: { 'fullDocument.htmlBody': 0 } },
      ],
      { fullDocument: 'updateLookup', ...start },
    );
    logger.info({ feed: name, resumed: 'resumeAfter' in start }, 'feed started');
    for await (const change of stream) {
      const event = await eventOf(change);
      if (event) {
        const token = (change._id as { _data: string })._data;
        await send(`change-${hash(token)}`, event);
      }
      await redis.set(keys.resume, JSON.stringify(change._id));
    }
    if (!closed) throw new Error(`${name} feed ended`);
  }

  const run = () => {
    follow().catch(async (err: unknown) => {
      if (closed) return;
      const code = (err as { code?: number }).code;
      if (code !== undefined && LOST_HISTORY.has(code)) {
        logger.warn({ feed: name, code }, 'feed history lost, sending everything again');
        for (const key of Object.values(keys)) await redis.del(key);
      } else {
        logger.warn({ feed: name, err: (err as Error).message }, 'feed interrupted, reopening');
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
