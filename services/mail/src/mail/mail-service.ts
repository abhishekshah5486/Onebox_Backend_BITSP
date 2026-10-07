import type { FolderRole } from '@onebox/contracts';
import { NotFoundError } from '@onebox/errors';
import type { Filter } from 'mongodb';
import type { MailCollections, MessageDoc, ThreadDoc } from '../db/collections';
import { refreshThread, uniqueMessages } from '../threads/thread-store';
import { pageThreads } from './paging';

export type ThreadFilter = 'all' | 'unread' | 'starred';

// Like Gmail, Starred spans every folder except spam and trash unless a folder is asked for.
const STARRED_FOLDERS: FolderRole[] = ['inbox', 'sent', 'drafts'];

export interface ListThreadsInput {
  accountId?: string | undefined;
  filter?: ThreadFilter | undefined;
  folder?: FolderRole | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

const toThreadView = (thread: ThreadDoc) => ({
  id: thread._id,
  accountId: thread.accountId,
  folders: thread.folders,
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
      { accountId, filter = 'all', folder, ...page }: ListThreadsInput,
    ) {
      const query: Filter<ThreadDoc> = { userId };
      if (accountId) query.accountId = accountId;
      query.folders = folder ?? (filter === 'starred' ? { $in: STARRED_FOLDERS } : 'inbox');
      if (filter === 'unread') query.unreadCount = { $gt: 0 };
      if (filter === 'starred') query.isStarred = true;
      const result = await pageThreads(threads, query, page);
      return { ...result, items: result.items.map(toThreadView) };
    },

    async getThread(userId: string, threadId: string) {
      const thread = await findOwnedThread(userId, threadId);
      const docs = await messages
        .find({ userId, threadId })
        .sort({ receivedAt: 1, uid: 1 })
        .toArray();
      return { thread: toThreadView(thread), messages: uniqueMessages(docs).map(toMessageView) };
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
        threads.countDocuments({ userId, folders: 'inbox', unreadCount: { $gt: 0 } }),
        threads.countDocuments({ userId, folders: { $in: STARRED_FOLDERS }, isStarred: true }),
        threads.countDocuments({ userId, folders: 'inbox' }),
      ]);
      return { unreadThreads: unread, starredThreads: starred, totalThreads: total };
    },
  };
}

export type MailService = ReturnType<typeof createMailService>;
