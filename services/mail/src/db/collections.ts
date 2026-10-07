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
  folder: string;
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
    messages.createIndex({ userId: 1, accountId: 1, folder: 1, uidValidity: 1, uid: 1 }),
    threads.createIndex({ userId: 1, lastMessageAt: -1, _id: -1 }),
    threads.createIndex({ userId: 1, accountId: 1, lastMessageAt: -1 }),
    threads.createIndex({ userId: 1, accountId: 1, normalizedSubject: 1, lastMessageAt: -1 }),
  ]);
}
