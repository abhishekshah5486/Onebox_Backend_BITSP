import type { SearchDocument } from '@onebox/contracts';
import { describe, expect, it } from 'vitest';
import { parseQuery } from '../query/parse';
import { embeddingText, pointId, vectorFilter } from './vector-index';

const doc: SearchDocument = {
  key: 'k1',
  copies: [{ messageId: 'm1', folder: 'INBOX', role: 'inbox' }],
  userId: 'u1',
  accountId: 'a1',
  threadId: 't1',
  from: { name: 'Alice', address: 'alice@x.com' },
  to: [],
  cc: [],
  subject: 'Trip',
  body: 'x'.repeat(20_000),
  attachmentNames: [],
  labels: [],
  categories: [],
  isRead: false,
  isStarred: false,
  sizeBytes: 100,
  receivedAt: '2026-10-01T00:00:00.000Z',
};

describe('vector index helpers', () => {
  it('maps an email key onto a stable uuid', () => {
    expect(pointId('k1')).toBe(pointId('k1'));
    expect(pointId('k1')).not.toBe(pointId('k2'));
    expect(pointId('k1')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('embeds the subject, sender and a capped body', () => {
    const text = embeddingText(doc);
    expect(text.startsWith('Subject: Trip\nFrom: Alice <alice@x.com>\n\n')).toBe(true);
    expect(text.length).toBe(8_000);
  });

  it('filters by user and hides spam and trash by default', () => {
    expect(vectorFilter('u1', parseQuery(''))).toEqual({
      must: [{ key: 'userId', match: { value: 'u1' } }],
      must_not: [{ key: 'roles', match: { any: ['spam', 'trash'] } }],
    });
  });

  it('applies operators as payload conditions', () => {
    const filter = vectorFilter(
      'u1',
      parseQuery('trip from:alice label:Travel is:starred in:inbox'),
    );
    expect(filter.must).toEqual(
      expect.arrayContaining([
        { key: 'from', match: { text: 'alice' } },
        { key: 'labels', match: { value: 'travel' } },
        { key: 'isStarred', match: { value: true } },
        { key: 'roles', match: { value: 'inbox' } },
      ]),
    );
    expect(filter.must_not).toEqual([]);
  });
});
