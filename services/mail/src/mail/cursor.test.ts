import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor';

describe('thread cursor', () => {
  it('round-trips', () => {
    const cursor = { lastMessageAt: new Date('2026-10-07T10:00:00Z'), lastUid: 42, id: 'abc' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    'garbage',
    Buffer.from('["not-a-date",1,"x"]').toString('base64url'),
    Buffer.from('["2026-10-07T10:00:00Z","x"]').toString('base64url'),
  ])('rejects %s', (bad) => {
    expect(() => decodeCursor(bad)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });
});
