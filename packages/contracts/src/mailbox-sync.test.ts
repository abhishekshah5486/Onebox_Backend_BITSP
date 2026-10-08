import { describe, expect, it } from 'vitest';
import {
  decodeUidSet,
  encodeUidSet,
  mailboxChangePayloadSchema,
  mailboxOpPayloadSchema,
} from './mailbox-sync';

describe('uid sets', () => {
  it('compresses runs and round-trips', () => {
    const set = encodeUidSet([9, 1, 2, 3, 5, 12, 13, 14, 3]);
    expect(set).toBe('1:3,5,9,12:14');
    expect([...decodeUidSet(set)]).toEqual([1, 2, 3, 5, 9, 12, 13, 14]);
  });

  it('handles empty folders', () => {
    expect(encodeUidSet([])).toBe('');
    expect(decodeUidSet('').size).toBe(0);
  });
});

describe('mailbox ops', () => {
  const base = { folder: 'INBOX', uidValidity: 3, uids: [4, 5] };

  it('accepts moves to a folder role or a label', () => {
    expect(
      mailboxOpPayloadSchema.safeParse({ ...base, op: { type: 'move', to: { role: 'archive' } } })
        .success,
    ).toBe(true);
    expect(
      mailboxOpPayloadSchema.safeParse({ ...base, op: { type: 'move', to: { label: 'Work' } } })
        .success,
    ).toBe(true);
  });

  it('only syncs the read and starred flags', () => {
    const op = (add: string[]) => ({ ...base, op: { type: 'flags', add, remove: [] } });
    expect(mailboxOpPayloadSchema.safeParse(op(['\\Seen'])).success).toBe(true);
    expect(mailboxOpPayloadSchema.safeParse(op(['\\Deleted'])).success).toBe(false);
  });

  it('rejects empty uid lists', () => {
    expect(
      mailboxOpPayloadSchema.safeParse({ ...base, uids: [], op: { type: 'expunge' } }).success,
    ).toBe(false);
  });
});

describe('mailbox changes', () => {
  it('defaults snapshot flags and moved keepSource', () => {
    const snapshot = mailboxChangePayloadSchema.parse({
      type: 'snapshot',
      folder: 'INBOX',
      role: 'inbox',
      uidValidity: 1,
      uidNext: 5,
      present: '1:4',
    });
    expect(snapshot).toMatchObject({ flags: [] });
    const moved = mailboxChangePayloadSchema.parse({
      type: 'moved',
      folder: 'INBOX',
      uidValidity: 1,
      to: { folder: 'Archive', role: 'archive', uidValidity: 2 },
      uidMap: [[4, 90]],
    });
    expect(moved).toMatchObject({ keepSource: false });
  });

  it('rejects malformed uid sets', () => {
    expect(
      mailboxChangePayloadSchema.safeParse({
        type: 'snapshot',
        folder: 'INBOX',
        role: 'inbox',
        uidValidity: 1,
        uidNext: 5,
        present: '1-4',
      }).success,
    ).toBe(false);
  });
});
