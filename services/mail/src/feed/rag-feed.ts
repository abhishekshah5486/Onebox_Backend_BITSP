import { createJobEnvelope, RAG_SKIPPED_ROLES, type RagMailPayload } from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import type { Producer } from '@onebox/queue';
import type { Collection, Db } from 'mongodb';
import type { MessageDoc } from '../db/collections';
import { emailKey, startMessageFeed, type FeedEvent, type ResumeStore } from './message-feed';

// Changes that leave what RAG reads (the email and which folders hold it) as it was.
const IGNORED_FIELDS = new Set([
  'pendingSince',
  'movingTo',
  'flags',
  'unsubscribe',
  'isRead',
  'isStarred',
  'aiLabels',
  'category',
  'categories',
  'aiCategories',
  'authentication',
]);

const skipped = new Set<string>(RAG_SKIPPED_ROLES);

// What RAG is told: the copies it may read the email from, or that none is left.
export function toRagJob(event: FeedEvent): { userId: string; payload: RagMailPayload } {
  if (event.kind === 'removed') {
    // A removed copy's owner isn't in its event; RAG finds it by the copy's id.
    return {
      userId: 'system',
      payload: { op: 'delete', version: event.version, messageId: event.messageId },
    };
  }
  const first = event.copies[0]!;
  const key = emailKey(first);
  const readable = event.copies
    .filter((copy) => !skipped.has(copy.role))
    .map((copy) => copy._id)
    .sort();
  return {
    userId: first.userId,
    payload:
      readable.length === 0
        ? { op: 'remove', version: event.version, key, accountId: first.accountId }
        : {
            op: 'upsert',
            version: event.version,
            key,
            accountId: first.accountId,
            messageIds: readable.slice(0, 100),
          },
  };
}

// Keeps the RAG service's mail records in step with stored mail.
export function startRagFeed({
  db,
  messages,
  redis,
  producer,
  logger,
}: {
  db: Db;
  messages: Collection<MessageDoc>;
  redis: ResumeStore;
  producer: Pick<Producer<RagMailPayload>, 'enqueue'>;
  logger: Logger;
}) {
  return startMessageFeed({
    name: 'rag',
    db,
    messages,
    redis,
    logger,
    ignoredFields: IGNORED_FIELDS,
    send: async (jobId, event) => {
      const { userId, payload } = toRagJob(event);
      await producer.enqueue(createJobEnvelope({ jobId, userId, payload }));
    },
  });
}
