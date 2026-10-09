import type { FolderRole, GmailCategory, MailCategory } from '@onebox/contracts';
import { NotFoundError } from '@onebox/errors';
import type { Filter } from 'mongodb';
import type { MailCollections, MessageDoc, ThreadDoc } from '../db/collections';
import { locationOf, uniqueMessages } from '../threads/thread-store';
import { pageThreads } from './paging';

export type ThreadFilter = 'all' | 'unread' | 'starred';

// Like Gmail, Starred spans every folder except spam and trash unless a folder is asked for.
const STARRED_FOLDERS: FolderRole[] = ['inbox', 'sent', 'drafts', 'archive'];

export interface ListThreadsInput {
  accountId?: string | undefined;
  filter?: ThreadFilter | undefined;
  folder?: FolderRole | undefined;
  label?: string | undefined;
  // Gmail inbox tab; other providers' mail counts as Primary.
  category?: GmailCategory | undefined;
  // A category view from the sidebar: mail with it in any folder but Spam and Trash.
  tagged?: MailCategory | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

const toThreadView = (thread: ThreadDoc) => ({
  id: thread._id,
  accountId: thread.accountId,
  folders: thread.folders,
  labels: thread.labels ?? [],
  aiLabels: thread.aiLabels ?? [],
  category: thread.category ?? null,
  categories: thread.categories ?? [],
  canUnsubscribe: thread.canUnsubscribe ?? false,
  unsubscribedAt: thread.unsubscribedAt?.toISOString() ?? null,
  subject: thread.subject,
  snippet: thread.snippet,
  participants: thread.participants,
  lastFrom: thread.lastFrom,
  messageCount: thread.messageCount,
  unreadCount: thread.unreadCount,
  isStarred: thread.isStarred,
  hasAttachments: thread.hasAttachments,
  attachments: thread.attachments ?? [],
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
  authentication: message.authentication ?? null,
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
      { accountId, filter = 'all', folder, label, category, tagged, ...page }: ListThreadsInput,
    ) {
      const query: Filter<ThreadDoc> = { userId };
      if (accountId) query.accountId = accountId;
      if (label) query.labels = label;
      else if (tagged) {
        query.categories = tagged;
        query.folders = folder ?? { $nin: ['spam', 'trash'] };
      } else query.folders = folder ?? (filter === 'starred' ? { $in: STARRED_FOLDERS } : 'inbox');
      if (category) query.category = category === 'primary' ? { $in: ['primary', null] } : category;
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
      const visible = docs.filter((doc) => locationOf(doc).role !== 'deleted');
      return { thread: toThreadView(thread), messages: uniqueMessages(visible).map(toMessageView) };
    },

    async threadViews(userId: string, threadIds: string[]) {
      const found = await threads.find({ _id: { $in: threadIds }, userId }).toArray();
      return found.map(toThreadView);
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
