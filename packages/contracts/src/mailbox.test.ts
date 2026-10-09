import { describe, expect, it } from 'vitest';
import { historyPayloadSchema, historyStateSchema, mailboxKeys } from './mailbox';

describe('mailbox contracts', () => {
  it('bounds history batch sizes', () => {
    const base = { folder: 'INBOX', role: 'inbox', uidValidity: 7, beforeUid: 100 };
    expect(historyPayloadSchema.safeParse({ ...base, count: 50 }).success).toBe(true);
    expect(historyPayloadSchema.safeParse({ ...base, count: 0 }).success).toBe(false);
    expect(historyPayloadSchema.safeParse({ ...base, count: 500 }).success).toBe(false);
    expect(historyPayloadSchema.safeParse({ ...base, count: 50, beforeUid: 0 }).success).toBe(
      false,
    );
  });

  it('accepts only known history statuses', () => {
    const state = { error: null, updatedAt: '2026-10-07T10:00:00.000Z' };
    expect(historyStateSchema.safeParse({ ...state, status: 'fetching' }).success).toBe(true);
    expect(historyStateSchema.safeParse({ ...state, status: 'done' }).success).toBe(false);
  });

  it('namespaces redis keys per account and folder', () => {
    expect(mailboxKeys.counts('a1', 'inbox')).toBe('mailbox:counts:a1:inbox');
    expect(mailboxKeys.history('a1', 'inbox')).not.toBe(mailboxKeys.counts('a1', 'inbox'));
  });
});
