import { describe, expect, it } from 'vitest';
import { parseQuery } from '../query/parse';
import { keywordQuery } from './keyword-query';

const build = (q: string) => keywordQuery('u1', parseQuery(q, new Date('2026-10-30T00:00:00Z')));

describe('keywordQuery', () => {
  it('scopes to the user and hides spam and trash by default', () => {
    const { bool } = build('');
    expect(bool.filter).toEqual([{ term: { userId: 'u1' } }]);
    expect(bool.must_not).toEqual([{ terms: { 'copies.role': ['spam', 'trash'] } }]);
  });

  it('includes spam and trash when a place is asked for', () => {
    expect(build('in:anywhere').bool.must_not).toEqual([]);
    expect(build('in:spam').bool.filter).toContainEqual({ term: { 'copies.role': 'spam' } });
  });

  it('needs every free word to match and each phrase in order', () => {
    const must = build('cheap flights "to paris"').bool.must as object[];
    expect(must[0]).toMatchObject({
      multi_match: { query: 'cheap flights', type: 'cross_fields', operator: 'and' },
    });
    expect(must[1]).toMatchObject({ multi_match: { query: 'to paris', type: 'phrase' } });
  });

  it('turns operators into matches and filters', () => {
    const { bool } = build(
      'from:alice -from:bob subject:invoice label:Work has:attachment is:unread larger:1M after:2026/01/01',
    );
    expect(bool.must).toContainEqual({
      multi_match: { query: 'alice', fields: ['from.name', 'from.address'], type: 'phrase' },
    });
    expect(bool.must).toContainEqual({ match_phrase: { subject: 'invoice' } });
    expect(bool.must_not).toContainEqual({
      multi_match: { query: 'bob', fields: ['from.name', 'from.address'], type: 'phrase' },
    });
    expect(bool.filter).toEqual(
      expect.arrayContaining([
        { term: { labels: 'Work' } },
        { exists: { field: 'attachmentNames' } },
        { term: { isRead: false } },
        { range: { sizeBytes: { gt: 1024 * 1024 } } },
        { range: { receivedAt: { gte: '2026-01-01T00:00:00.000Z' } } },
      ]),
    );
  });
});
