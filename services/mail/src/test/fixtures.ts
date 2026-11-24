import {
  createJobEnvelope,
  type GmailCategory,
  ingestDedupeKey,
  type MailboxRole,
  type MailCategory,
  type IngestPayload,
} from '@onebox/contracts';

import type { MessageDoc } from '../db/collections';

type Indexed = Omit<MessageDoc, 'htmlBody'>;

let nextUid = 1;

export interface MailSpec {
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  from?: string;
  date?: string;
  body?: string;
  headers?: string[];
}

export function rawMessage({
  subject = 'Hello',
  messageId,
  inReplyTo,
  references,
  from = 'Priya <priya@acme.example>',
  date = 'Tue, 06 Oct 2026 10:00:00 +0000',
  body = 'Hello there',
  headers = [],
}: MailSpec): string {
  return [
    `From: ${from}`,
    'To: me@gmail.com',
    `Subject: ${subject}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    `Date: ${date}`,
    ...headers,
    '',
    body,
  ].join('\r\n');
}

export function ingestJob(
  spec: MailSpec & {
    userId?: string;
    accountId?: string;
    flags?: string[];
    uid?: number;
    backfill?: boolean;
    folder?: { path: string; role: MailboxRole };
    uidValidity?: number;
    category?: GmailCategory | null;
    categories?: MailCategory[];
  },
) {
  const folder = spec.folder ?? { path: 'INBOX', role: 'inbox' as const };
  const uid = spec.uid ?? nextUid++;
  const accountId = spec.accountId ?? 'acc-1';
  const uidValidity = spec.uidValidity ?? 1;
  const raw = rawMessage(spec);
  const payload: IngestPayload = {
    folder: folder.path,
    role: folder.role,
    category: spec.category ?? null,
    categories: spec.categories ?? [],
    uid,
    uidValidity,
    flags: spec.flags ?? [],
    internalDate: spec.date ? new Date(spec.date).toISOString() : null,
    sizeBytes: raw.length,
    backfill: spec.backfill ?? false,
    rawSource: Buffer.from(raw).toString('base64'),
  };
  return createJobEnvelope({
    jobId: ingestDedupeKey({ accountId, folder: folder.path, uidValidity, uid }),
    userId: spec.userId ?? 'user-1',
    accountId,
    payload,
  });
}

// A stored message as the search feed reads it (no HTML body).
export const storedMessage = (overrides: Partial<Indexed> = {}): Indexed =>
  ({
    _id: 'm1',
    userId: 'u1',
    accountId: 'a1',
    threadId: 't1',
    folder: 'INBOX',
    role: 'inbox',
    from: { name: 'Priya', address: 'priya@acme.example' },
    to: [{ name: null, address: 'me@gmail.com' }],
    cc: [],
    subject: 'Pricing for 20 seats',
    snippet: 'Sharing the quote',
    textBody: 'Sharing the quote for 20 seats.',
    attachments: [
      { filename: 'quote.pdf', contentType: 'application/pdf', sizeBytes: 10, inline: false },
      { filename: 'logo.png', contentType: 'image/png', sizeBytes: 5, inline: true },
    ],
    aiLabels: ['Sales'],
    categories: ['updates'],
    isRead: false,
    isStarred: true,
    sizeBytes: 2048,
    receivedAt: new Date('2026-10-30T10:00:00.000Z'),
    ...overrides,
  }) as Indexed;
