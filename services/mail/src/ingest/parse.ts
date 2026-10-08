import { simpleParser, type AddressObject } from 'mailparser';
import type { Address, AttachmentMeta } from '../db/collections';
import { sanitizeEmailHtml } from './sanitize';
import { findUnsubscribe, type Unsubscribe } from './unsubscribe';

export interface ParsedMessage {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address | null;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  sentAt: Date | null;
  textBody: string;
  htmlBody: string | null;
  hasRemoteImages: boolean;
  snippet: string;
  attachments: AttachmentMeta[];
  unsubscribe: Unsubscribe | null;
}

const MAX_TEXT_CHARS = 200_000;

function addresses(field: AddressObject | AddressObject[] | undefined): Address[] {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list
    .flatMap((group) => group.value)
    .filter((entry) => entry.address)
    .map((entry) => ({ name: entry.name ?? '', address: entry.address!.toLowerCase() }));
}

const ids = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value : value ? value.split(/\s+/) : [])
    .map((id) => id.trim())
    .filter(Boolean);

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function makeSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  // skipHtmlToText: mailparser's own conversion uppercases headings and inlines URLs.
  const mail = await simpleParser(raw, {
    skipHtmlToText: true,
    skipImageLinks: true,
    skipTextLinks: true,
  });
  const sanitized = typeof mail.html === 'string' ? sanitizeEmailHtml(mail.html) : null;
  const textBody = (
    mail.text || (typeof mail.html === 'string' ? htmlToText(mail.html) : '')
  ).slice(0, MAX_TEXT_CHARS);

  return {
    messageIdHeader: mail.messageId ?? null,
    inReplyTo: ids(mail.inReplyTo)[0] ?? null,
    references: ids(mail.references),
    from: addresses(mail.from)[0] ?? null,
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    replyTo: addresses(mail.replyTo),
    subject: (mail.subject ?? '').trim(),
    sentAt: mail.date ?? null,
    textBody,
    htmlBody: sanitized?.html ?? null,
    hasRemoteImages: sanitized?.hasRemoteImages ?? false,
    snippet: makeSnippet(textBody),
    attachments: mail.attachments.map((attachment) => ({
      filename: attachment.filename ?? 'attachment',
      contentType: attachment.contentType,
      sizeBytes: attachment.size,
      inline: attachment.contentDisposition === 'inline',
    })),
    unsubscribe: findUnsubscribe(
      mail.headers.get('list'),
      typeof mail.html === 'string' ? mail.html : null,
      textBody,
    ),
  };
}
