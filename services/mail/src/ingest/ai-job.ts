import { createJobEnvelope, type AiClassifyPayload } from '@onebox/contracts';
import type { Address, MessageDoc } from '../db/collections';

const MAX_BODY = 8000;

const show = (address: Address | null) =>
  address ? (address.name ? `${address.name} <${address.address}>` : address.address) : '';

// The new part of a reply: quoted lines and the "On … wrote:" tail are dropped.
export function freshText(text: string): string {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (
      /^On .{4,200} wrote:\s*$/.test(line.trim()) ||
      /^-{2,}\s*Original Message/i.test(line.trim())
    )
      break;
    if (!line.startsWith('>')) lines.push(line);
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY);
}

export function aiJob(doc: MessageDoc) {
  const payload: AiClassifyPayload = {
    messageId: doc._id,
    threadId: doc.threadId,
    from: show(doc.from).slice(0, 400),
    to: [...doc.to, ...doc.cc].map(show).join(', ').slice(0, 2000),
    subject: doc.subject.slice(0, 1000),
    body: freshText(doc.textBody),
    snippet: doc.snippet.slice(0, 300),
    receivedAt: doc.receivedAt.toISOString(),
  };
  return createJobEnvelope({
    jobId: `classify-${doc._id}`,
    userId: doc.userId,
    accountId: doc.accountId,
    payload,
  });
}
