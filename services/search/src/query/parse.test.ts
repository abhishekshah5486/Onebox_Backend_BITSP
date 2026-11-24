import { describe, expect, it } from 'vitest';
import { freeText, parseQuery } from './parse';

const NOW = new Date('2026-10-30T12:00:00Z');

describe('parseQuery', () => {
  it('splits free text into words, phrases and exclusions', () => {
    const query = parseQuery('invoice "quarterly report" -spam', NOW);
    expect(query).toMatchObject({
      words: ['invoice'],
      phrases: ['quarterly report'],
      excluded: ['spam'],
    });
    expect(freeText(query)).toBe('quarterly report invoice');
  });

  it('reads address, subject and label operators', () => {
    expect(
      parseQuery(
        'from:alice@x.com -from:bob to:me subject:"hello there" label:"Uni Rejection"',
        NOW,
      ),
    ).toMatchObject({
      from: ['alice@x.com'],
      notFrom: ['bob'],
      to: ['me'],
      subject: ['hello there'],
      labels: ['Uni Rejection'],
    });
  });

  it('reads place, state and attachment operators', () => {
    expect(parseQuery('in:trash is:unread is:starred has:attachment', NOW)).toMatchObject({
      in: 'trash',
      isUnread: true,
      isStarred: true,
      hasAttachment: true,
    });
    expect(parseQuery('is:read in:nowhere', NOW)).toMatchObject({ isUnread: false, in: null });
  });

  it('keeps only known categories', () => {
    expect(parseQuery('category:Promotions category:bogus', NOW).categories).toEqual([
      'promotions',
    ]);
  });

  it('reads sizes in bytes or with a unit', () => {
    expect(parseQuery('larger:10M smaller:500K', NOW)).toMatchObject({
      largerThan: 10 * 1024 * 1024,
      smallerThan: 500 * 1024,
    });
    expect(parseQuery('larger:2000', NOW).largerThan).toBe(2000);
    expect(parseQuery('larger:huge', NOW).largerThan).toBeNull();
  });

  it('reads absolute and relative dates, keeping the tighter bound', () => {
    expect(parseQuery('after:2026/01/15 before:2026-02-01', NOW)).toMatchObject({
      after: new Date('2026-01-15'),
      before: new Date('2026-02-01'),
    });
    expect(parseQuery('newer_than:2d', NOW).after).toEqual(new Date('2026-10-28T12:00:00Z'));
    expect(parseQuery('older_than:1m', NOW).before).toEqual(new Date('2026-09-30T12:00:00Z'));
    expect(parseQuery('after:2020/01/01 newer_than:1y', NOW).after).toEqual(
      new Date('2025-10-30T12:00:00Z'),
    );
    expect(parseQuery('after:someday', NOW).after).toBeNull();
  });

  it('treats an empty query as no constraints', () => {
    expect(parseQuery('', NOW)).toMatchObject({ words: [], phrases: [], in: null, after: null });
  });
});
