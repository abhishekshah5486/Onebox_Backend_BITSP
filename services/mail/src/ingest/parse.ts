import { createHash } from 'node:crypto';
import { decodeHTML } from 'entities';
import { convert } from 'html-to-text';
import { simpleParser, type AddressObject } from 'mailparser';
import type { Address, AttachmentMeta } from '../db/collections';
import { readAuthentication, type Authentication } from './authentication';
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
  // Which rules made textBody and snippet; older mail is redone when they change.
  textVersion: number;
  attachments: AttachmentMeta[];
  unsubscribe: Unsubscribe | null;
  authentication: Authentication;
}

const MAX_TEXT_CHARS = 200_000;
export const TEXT_VERSION = 2;

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

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

// Readable text from HTML: links keep their words only, images go, headings keep their case.
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      ...HEADINGS.map((selector) => ({ selector, options: { uppercase: false } })),
    ],
  });
}

// Some senders put their HTML in the plain-text part too.
const looksLikeHtml = (text: string) =>
  /<(!doctype|html|head|body|div|p|table|tr|td|span|br|a|img|style)\b[^>]*>/i.test(text);
export const readableText = (text: string) => (looksLikeHtml(text) ? htmlToText(text) : text);

// Invisible characters senders pad previews with (e.g. U+034F, U+FEFF, soft hyphens).
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
// Plain-text links written as "Docs<https://…>".
const BRACKETED_LINK = /<(?:https?|mailto):[^>\s]*>/gi;

export function makeSnippet(text: string): string {
  return decodeHTML(text)
    .replace(BRACKETED_LINK, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  return (await parseMail(raw)).message;
}

// The message, plus its attachments' contents in the same order as message.attachments.
export async function parseMail(raw: Buffer): Promise<{ message: ParsedMessage; files: Buffer[] }> {
  // skipHtmlToText: mailparser's own conversion uppercases headings and inlines URLs.
  const mail = await simpleParser(raw, {
    skipHtmlToText: true,
    skipImageLinks: true,
    skipTextLinks: true,
  });
  const sanitized = typeof mail.html === 'string' ? sanitizeEmailHtml(mail.html) : null;
  const textBody = (
    mail.text ? readableText(mail.text) : typeof mail.html === 'string' ? htmlToText(mail.html) : ''
  ).slice(0, MAX_TEXT_CHARS);

  const message: ParsedMessage = {
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
    textVersion: TEXT_VERSION,
    attachments: mail.attachments.map((attachment) => ({
      filename: attachment.filename ?? 'attachment',
      contentType: attachment.contentType,
      sizeBytes: attachment.size,
      inline: attachment.contentDisposition === 'inline',
      sha256: createHash('sha256').update(attachment.content).digest('hex'),
    })),
    authentication: readAuthentication(mail.headers),
    unsubscribe: findUnsubscribe(
      mail.headers.get('list'),
      typeof mail.html === 'string' ? mail.html : null,
      textBody,
    ),
  };
  return { message, files: mail.attachments.map((attachment) => attachment.content) };
}
