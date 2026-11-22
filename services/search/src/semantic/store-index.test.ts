import { describe, expect, it } from 'vitest';
import { parseQuery } from '../query/parse';
import { matchesQuery } from './store-index';
import type { Payload } from './vector-index';

const payload = (extra: Partial<Payload> = {}): Payload => ({
  key: 'k',
  copies: [{ messageId: 'm1', folder: 'INBOX', role: 'inbox' }],
  roles: ['inbox'],
  aiLabels: [],
  labels: ['work'],
  version: 1,
  contentHash: 'h',
  from: 'Ada Lovelace ada@example.com',
  categories: ['updates'],
  isRead: false,
  isStarred: true,
  hasAttachment: true,
  sizeBytes: 2_000_000,
  receivedAt: '2026-11-10T10:00:00.000Z',
  ...extra,
});

describe('matchesQuery', () => {
  it('applies the same filters the Qdrant query does', () => {
    const yes = (q: string, p = payload()) => expect(matchesQuery(p, parseQuery(q))).toBe(true);
    const no = (q: string, p = payload()) => expect(matchesQuery(p, parseQuery(q))).toBe(false);
    yes('budget');
    yes('from:ada label:Work is:unread is:starred has:attachment larger:1M');
    yes('after:2026/11/01 before:2026/11/20');
    no('from:grace');
    no('label:personal');
    no('is:read');
    no('smaller:1M');
    no('before:2026/11/01');
    no('budget', payload({ roles: ['trash'] }));
    yes('in:trash', payload({ roles: ['trash'] }));
    yes('in:anywhere', payload({ roles: ['spam'] }));
  });
});
