import { NotFoundError } from '@onebox/errors';
import type { Filter } from 'mongodb';
import type { MailCollections, MessageDoc, ThreadDoc } from '../db/collections';
import { refreshThread } from '../threads/thread-store';
import { decodeCursor, encodeCursor } from './cursor';

export type ThreadFilter = 'all' | 'unread' | 'starred';

export interface ListThreadsInput {
  accountId?: string | undefined;
  filter?: ThreadFilter | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

const toThreadView = (thread: ThreadDoc) => ({
  id: thread._id,
  accountId: thread.accountId,
  subject: thread.subject,
  snippet: thread.snippet,
  participants: thread.participants,
  lastFrom: thread.lastFrom,
  messageCount: thread.messageCount,
  unreadCount: thread.unreadCount,
  isStarred: thread.isStarred,
  hasAttachments: thread.hasAttachments,
  lastMessageAt: thread.lastMessageAt.toISOString(),
});

const toMessageView = (message: MessageDoc) => ({
  id: message._id,
  accountId: message.accountId,
  from: message.from,
  to: message.to,
  cc: message.cc,
  replyTo: message.replyTo,
  subject: message.subject,
  snippet: message.snippet,
  textBody: message.textBody,
  htmlBody: message.htmlBody,
  hasRemoteImages: message.hasRemoteImages,
  attachments: message.attachments,
  isRead: message.isRead,
  isStarred: message.isStarred,
  receivedAt: message.receivedAt.toISOString(),
  sentAt: message.sentAt?.toISOString() ?? null,
});

export type ThreadView = ReturnType<typeof toThreadView>;
export type MessageView = ReturnType<typeof toMessageView>;

export function createMailService(collections: MailCollections) {
  const { messages, threads } = collections;

  async function findOwnedThread(userId: string, threadId: string) {
    const thread = await threads.findOne({ _id: threadId, userId });
    if (!thread) throw new NotFoundError('Conversation not found');
    return thread;
  }

  return {
    async listThreads(
      userId: string,
      { accountId, filter = 'all', cursor, limit = 50 }: ListThreadsInput,
    ) {
      const query: Filter<ThreadDoc> = { userId };
      if (accountId) query.accountId = accountId;
      if (filter === 'unread') query.unreadCount = { $gt: 0 };
      if (filter === 'starred') query.isStarred = true;
      if (cursor) {
        const { lastMessageAt, id } = decodeCursor(cursor);
        query.$or = [
          { lastMessageAt: { $lt: lastMessageAt } },
          { lastMessageAt, _id: { $lt: id } },
        ];
      }

      const page = await threads
        .find(query)
        .sort({ lastMessageAt: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();
      const items = page.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map(toThreadView),
        nextCursor:
          page.length > limit && last
            ? encodeCursor({ lastMessageAt: last.lastMessageAt, id: last._id })
            : null,
      };
    },

    async getThread(userId: string, threadId: string) {
      const thread = await findOwnedThread(userId, threadId);
      const docs = await messages.find({ userId, threadId }).sort({ receivedAt: 1 }).toArray();
      return { thread: toThreadView(thread), messages: docs.map(toMessageView) };
    },

    async updateThread(
      userId: string,
      threadId: string,
      changes: { isRead?: boolean; isStarred?: boolean },
    ) {
      await findOwnedThread(userId, threadId);
      if (changes.isRead !== undefined) {
        await messages.updateMany({ userId, threadId }, { $set: { isRead: changes.isRead } });
      }
      if (changes.isStarred === false) {
        await messages.updateMany({ userId, threadId }, { $set: { isStarred: false } });
      } else if (changes.isStarred) {
        // Like Gmail, starring a conversation stars its latest message.
        const [latest] = await messages
          .find({ userId, threadId })
          .sort({ receivedAt: -1 })
          .limit(1)
          .toArray();
        if (latest) await messages.updateOne({ _id: latest._id }, { $set: { isStarred: true } });
      }
      await refreshThread(collections, threadId);
      return toThreadView(await findOwnedThread(userId, threadId));
    },

    async stats(userId: string) {
      const [unread, starred, total] = await Promise.all([
        threads.countDocuments({ userId, unreadCount: { $gt: 0 } }),
        threads.countDocuments({ userId, isStarred: true }),
        threads.countDocuments({ userId }),
      ]);
      return { unreadThreads: unread, starredThreads: starred, totalThreads: total };
    },
  };
}

export type MailService = ReturnType<typeof createMailService>;
