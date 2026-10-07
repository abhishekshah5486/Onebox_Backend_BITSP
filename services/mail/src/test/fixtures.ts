import { createJobEnvelope, ingestDedupeKey, type IngestPayload } from '@onebox/contracts';

let nextUid = 1;

export interface MailSpec {
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  from?: string;
  date?: string;
  body?: string;
}

export function rawMessage({
  subject = 'Hello',
  messageId,
  inReplyTo,
  references,
  from = 'Priya <priya@acme.example>',
  date = 'Tue, 06 Oct 2026 10:00:00 +0000',
  body = 'Hello there',
}: MailSpec): string {
  return [
    `From: ${from}`,
    'To: me@gmail.com',
    `Subject: ${subject}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    `Date: ${date}`,
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
  },
) {
  const uid = spec.uid ?? nextUid++;
  const accountId = spec.accountId ?? 'acc-1';
  const raw = rawMessage(spec);
  const payload: IngestPayload = {
    folder: 'INBOX',
    role: 'inbox',
    uid,
    uidValidity: 1,
    flags: spec.flags ?? [],
    internalDate: spec.date ? new Date(spec.date).toISOString() : null,
    sizeBytes: raw.length,
    backfill: spec.backfill ?? false,
    rawSource: Buffer.from(raw).toString('base64'),
  };
  return createJobEnvelope({
    jobId: ingestDedupeKey({ accountId, folder: 'INBOX', uidValidity: 1, uid }),
    userId: spec.userId ?? 'user-1',
    accountId,
    payload,
  });
}
