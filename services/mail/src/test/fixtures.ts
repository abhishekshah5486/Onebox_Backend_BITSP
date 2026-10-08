import {
  createJobEnvelope,
  type GmailCategory,
  ingestDedupeKey,
  type MailboxRole,
  type IngestPayload,
} from '@onebox/contracts';

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
