import type { FolderRole, GmailCategory, MailboxRole, MailCategory } from '@onebox/contracts';
import type { Authentication } from '../ingest/authentication';
import type { Unsubscribe } from '../ingest/unsubscribe';
import type { Collection, Db } from 'mongodb';

export interface Address {
  name: string;
  address: string;
}

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  sizeBytes: number;
  inline: boolean;
}

// _id is the ingest dedupe key, which makes storing a message idempotent.
export interface MessageDoc {
  _id: string;
  userId: string;
  accountId: string;
  threadId: string;
  // Where the message is on the server; changes only once the server confirms a move.
  folder: string;
  role: MailboxRole;
  uid: number;
  uidValidity: number;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address | null;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  snippet: string;
  textBody: string;
  htmlBody: string | null;
  hasRemoteImages: boolean;
  attachments: AttachmentMeta[];
  flags: string[];
  isRead: boolean;
  isStarred: boolean;
  receivedAt: Date;
  sentAt: Date | null;
  sizeBytes: number;
  backfill: boolean;
  category: GmailCategory | null;
  // Every Gmail category (tabs, Purchases, Travel); missing on mail stored before them.
  categories?: MailCategory[];
  unsubscribe: Unsubscribe | null;
  // Missing on mail stored before it was recorded.
  authentication?: Authentication;
  // Set while a change made in OneBox is on its way to the server, so a sync from the
  // server (taken before the change landed) does not undo it.
  pendingSince: Date | null;
  // Where it is shown meanwhile: a folder role, a label path, or nowhere ('deleted').
  movingTo: { role: MailboxRole | 'deleted'; folder: string | null } | null;
  createdAt: Date;
}

export interface ThreadDoc {
  _id: string;
  userId: string;
  accountId: string;
  subject: string;
  normalizedSubject: string;
  participants: Address[];
  messageCount: number;
  unreadCount: number;
  isStarred: boolean;
  hasAttachments: boolean;
  snippet: string;
  lastFrom: Address | null;
  lastMessageAt: Date;
  // Every folder holding at least one of its messages, so one conversation can show in several.
  folders: FolderRole[];
  // Label paths (Gmail labels, or the provider's own folders).
  labels: string[];
  // Gmail inbox tab of the newest inbox message; null elsewhere.
  category: GmailCategory | null;
  // Every category any of its messages carries, for the sidebar's category views.
  categories: MailCategory[];
  canUnsubscribe: boolean;
  unsubscribedAt: Date | null;
  // UID of the newest message; orders conversations that share the same second.
  lastUid: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailCollections {
  messages: Collection<MessageDoc>;
  threads: Collection<ThreadDoc>;
}

export function mailCollections(db: Db): MailCollections {
  return {
    messages: db.collection<MessageDoc>('messages'),
    threads: db.collection<ThreadDoc>('threads'),
  };
}

export async function ensureIndexes({ messages, threads }: MailCollections): Promise<void> {
  await Promise.all([
    messages.createIndex({ userId: 1, threadId: 1, receivedAt: 1 }),
    messages.createIndex({ userId: 1, accountId: 1, messageIdHeader: 1 }),
    messages.createIndex({ userId: 1, receivedAt: -1 }),
    messages.createIndex({ userId: 1, accountId: 1, role: 1, uidValidity: 1, uid: 1 }),
    threads.createIndex({ userId: 1, folders: 1, lastMessageAt: -1, lastUid: -1, _id: -1 }),
    threads.createIndex({
      userId: 1,
      accountId: 1,
      folders: 1,
      lastMessageAt: -1,
      lastUid: -1,
      _id: -1,
    }),
    threads.createIndex({ userId: 1, accountId: 1, normalizedSubject: 1, lastMessageAt: -1 }),
    threads.createIndex({ userId: 1, accountId: 1, labels: 1, lastMessageAt: -1, lastUid: -1 }),
    threads.createIndex({ userId: 1, folders: 1, category: 1, lastMessageAt: -1, lastUid: -1 }),
    threads.createIndex({ userId: 1, categories: 1, lastMessageAt: -1, lastUid: -1 }),
    messages.createIndex({ accountId: 1, folder: 1, uidValidity: 1, uid: 1 }),
  ]);
}
