import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor';

describe('thread cursor', () => {
  it('round-trips', () => {
    const cursor = { lastMessageAt: new Date('2026-10-07T10:00:00Z'), id: 'abc' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each(['garbage', Buffer.from('["not-a-date","x"]').toString('base64url')])(
    'rejects %s',
    (bad) => {
      expect(() => decodeCursor(bad)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    },
  );
});
