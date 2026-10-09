import type { OutgoingAttachment, Recipient } from '@onebox/contracts';
import type { Collection, Db } from 'mongodb';

// What a message being written or sent says; drafts and the outbox share it.
export interface Composition {
  // Sent from this mailbox; a draft may not have picked one yet.
  accountId: string | null;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  html: string;
  text: string;
  attachments: OutgoingAttachment[];
  // The stored message this replies to or forwards, which threads it.
  replyTo: { messageId: string; mode: 'reply' | 'replyAll' | 'forward' } | null;
}

export interface DraftDoc extends Composition {
  _id: string;
  userId: string;
  // Why it's a draft again, when a send failed or was undone.
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// A message on its way: held until sendAt (so it can be undone), then sent by the connector.
export interface OutboxDoc extends Composition {
  _id: string;
  userId: string;
  accountId: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  threadId: string | null;
  status: 'scheduled' | 'sent' | 'failed' | 'cancelled';
  error: string | null;
  sendAt: Date;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ComposeCollections {
  drafts: Collection<DraftDoc>;
  outbox: Collection<OutboxDoc>;
}

export function composeCollections(db: Db): ComposeCollections {
  return {
    drafts: db.collection<DraftDoc>('drafts'),
    outbox: db.collection<OutboxDoc>('outbox'),
  };
}

export async function ensureComposeIndexes({ drafts, outbox }: ComposeCollections) {
  await Promise.all([
    drafts.createIndex({ userId: 1, updatedAt: -1 }),
    outbox.createIndex({ userId: 1, createdAt: -1 }),
    outbox.createIndex({ userId: 1, status: 1, createdAt: -1 }),
  ]);
}
