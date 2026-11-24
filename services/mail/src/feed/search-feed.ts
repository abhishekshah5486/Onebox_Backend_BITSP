import {
  createJobEnvelope,
  MAX_INDEXED_BODY_CHARS,
  type IndexPayload,
  type SearchDocument,
} from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import type { Producer } from '@onebox/queue';
import type { ChangeStreamDocument, Collection, Db } from 'mongodb';
import type { MessageDoc } from '../db/collections';
import {
  changedCopy as feedChangedCopy,
  emailKey,
  feedKeys,
  startMessageFeed,
  type FeedMessage,
  type ResumeStore,
} from './message-feed';

export { versionOf } from './message-feed';
export type { ResumeStore } from './message-feed';

const KEYS = feedKeys('search');
export const RESUME_KEY = KEYS.resume;
export const START_KEY = KEYS.start;
export const BACKFILL_KEY = KEYS.backfill;
// Changes search doesn't care about: bookkeeping while an action reaches the server.
const IGNORED_FIELDS = new Set(['pendingSince', 'movingTo', 'flags', 'unsubscribe']);

export const searchKey = emailKey;

// The copies of one email, merged: content from the first, folders and flags from all.
export function toSearchDocument(copies: FeedMessage[]): SearchDocument {
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

export const changedCopy = (change: ChangeStreamDocument<FeedMessage>) =>
  feedChangedCopy(change, IGNORED_FIELDS);

// Keeps the search service's indexes in step with stored mail.
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
  return startMessageFeed({
    name: 'search',
    db,
    messages,
    redis,
    logger,
    ignoredFields: IGNORED_FIELDS,
    send: async (jobId, event) => {
      // A removed copy's owner isn't in its event; search finds it by the copy's id.
      const [userId, payload]: [string, IndexPayload] =
        event.kind === 'removed'
          ? ['system', { op: 'delete', version: event.version, messageId: event.messageId }]
          : (() => {
              const doc = toSearchDocument(event.copies);
              return [doc.userId, { op: 'upsert', version: event.version, doc }];
            })();
      for (const queue of queues) {
        await queue.enqueue(createJobEnvelope({ jobId, userId, payload }));
      }
    },
  });
}
