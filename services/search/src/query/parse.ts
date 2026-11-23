import { MAIL_CATEGORIES, type MailCategory } from '@onebox/contracts';
import bytes from 'bytes';
import searchQuery from 'search-query-parser';

// Gmail's search operators; anything else is matched as text.
const KEYWORDS = [
  'from',
  'to',
  'cc',
  'subject',
  'label',
  'category',
  'filename',
  'in',
  'is',
  'has',
  'larger',
  'smaller',
  'after',
  'before',
  'newer_than',
  'older_than',
] as const;

type Keyword = (typeof KEYWORDS)[number];

const PLACES = ['inbox', 'sent', 'drafts', 'spam', 'trash', 'archive', 'anywhere'] as const;
export type Place = (typeof PLACES)[number];

export interface ParsedQuery {
  words: string[];
  phrases: string[];
  excluded: string[];
  from: string[];
  to: string[];
  cc: string[];
  subject: string[];
  notFrom: string[];
  labels: string[];
  categories: MailCategory[];
  filenames: string[];
  in: Place | null;
  isUnread: boolean | null;
  isStarred: boolean | null;
  hasAttachment: boolean;
  largerThan: number | null;
  smallerThan: number | null;
  after: Date | null;
  before: Date | null;
}

const asList = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

// Gmail sizes are bytes, or a number with K/M/G.
function parseSize(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i.exec(value.trim());
  if (!match) return null;
  return bytes.parse(`${match[1]}${match[2] ? `${match[2]}b` : 'b'}`);
}

// after:2024/01/15, before:2024-01-15
function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value.replaceAll('/', '-'));
  return Number.isNaN(date.getTime()) ? null : date;
}

// newer_than:2d, older_than:3m, newer_than:1y (Gmail's d/m/y units).
function ago(value: string | undefined, now: Date): Date | null {
  const match = value && /^(\d+)([dmy])$/i.exec(value.trim());
  if (!match) return null;
  const date = new Date(now);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit === 'd') date.setUTCDate(date.getUTCDate() - amount);
  if (unit === 'm') date.setUTCMonth(date.getUTCMonth() - amount);
  if (unit === 'y') date.setUTCFullYear(date.getUTCFullYear() - amount);
  return date;
}

const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
const earlier = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b));

export function parseQuery(q: string, now: Date = new Date()): ParsedQuery {
  const parsed = searchQuery.parse(q, {
    keywords: [...KEYWORDS],
    tokenize: true,
    alwaysArray: true,
    offsets: false,
  });
  const result = (typeof parsed === 'string' ? { text: [parsed] } : parsed) as Partial<
    Record<Keyword | 'text', string[]>
  > & { exclude?: Partial<Record<Keyword | 'text', string | string[]>> };
  const values = (key: Keyword) =>
    asList(result[key])
      .map((v) => v.trim())
      .filter(Boolean);
  const last = (key: Keyword) => values(key).at(-1)?.toLowerCase();
  const text = asList(result.text)
    .map((v) => v.trim())
    .filter(Boolean);
  const is = values('is').map((v) => v.toLowerCase());
  const place = last('in');

  return {
    words: text.filter((t) => !/\s/.test(t)),
    phrases: text.filter((t) => /\s/.test(t)),
    excluded: asList(result.exclude?.text).filter(Boolean),
    from: values('from'),
    to: values('to'),
    cc: values('cc'),
    subject: values('subject'),
    notFrom: asList(result.exclude?.from).filter(Boolean),
    labels: values('label'),
    categories: values('category')
      .map((v) => v.toLowerCase())
      .filter((v): v is MailCategory => (MAIL_CATEGORIES as readonly string[]).includes(v)),
    filenames: values('filename'),
    in: PLACES.find((p) => p === place) ?? null,
    isUnread: is.includes('unread') ? true : is.includes('read') ? false : null,
    isStarred: is.includes('starred') ? true : null,
    hasAttachment: values('has').some((v) => v.toLowerCase() === 'attachment'),
    largerThan: parseSize(values('larger').at(-1)),
    smallerThan: parseSize(values('smaller').at(-1)),
    after: later(parseDate(values('after').at(-1)), ago(values('newer_than').at(-1), now)),
    before: earlier(parseDate(values('before').at(-1)), ago(values('older_than').at(-1), now)),
  };
}

// The free text a semantic search embeds: what's left once operators are taken out.
export const freeText = (query: ParsedQuery) => [...query.phrases, ...query.words].join(' ');
