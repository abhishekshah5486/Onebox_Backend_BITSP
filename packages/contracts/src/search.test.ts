import { describe, expect, it } from 'vitest';
import { indexPayloadSchema, MAX_INDEXED_BODY_CHARS } from './search';

const doc = {
  key: 'k1',
  copies: [
    { messageId: 'm1', folder: 'INBOX', role: 'inbox' },
    { messageId: 'm1-all', folder: '[Gmail]/All Mail', role: 'archive' },
  ],
  userId: 'u1',
  accountId: 'a1',
  threadId: 't1',
  from: { name: 'Priya', address: 'priya@acme.example' },
  to: [],
  cc: [],
  subject: 'Pricing',
  body: 'Hi',
  attachmentNames: [],
  labels: [],
  categories: ['updates'],
  isRead: false,
  isStarred: false,
  sizeBytes: 1200,
  receivedAt: '2026-10-30T10:00:00.000Z',
};

describe('index payload', () => {
  it('carries a whole email to upsert, or the removed copy, with a version', () => {
    expect(indexPayloadSchema.parse({ op: 'upsert', version: 5, doc }).op).toBe('upsert');
    const remove = { op: 'delete', version: 6, messageId: 'm1' };
    expect(indexPayloadSchema.parse(remove)).toEqual(remove);
    expect(indexPayloadSchema.safeParse({ op: 'delete', messageId: 'm1' }).success).toBe(false);
  });

  it('needs at least one copy', () => {
    expect(
      indexPayloadSchema.safeParse({ op: 'upsert', version: 1, doc: { ...doc, copies: [] } })
        .success,
    ).toBe(false);
  });

  it('rejects an uncut body and unknown roles', () => {
    const long = { ...doc, body: 'x'.repeat(MAX_INDEXED_BODY_CHARS + 1) };
    expect(indexPayloadSchema.safeParse({ op: 'upsert', version: 1, doc: long }).success).toBe(
      false,
    );
    expect(
      indexPayloadSchema.safeParse({
        op: 'upsert',
        version: 1,
        doc: { ...doc, copies: [{ messageId: 'm1', folder: 'X', role: 'nowhere' }] },
      }).success,
    ).toBe(false);
  });
});
