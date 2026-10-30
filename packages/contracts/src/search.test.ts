import { describe, expect, it } from 'vitest';
import { indexPayloadSchema, MAX_INDEXED_BODY_CHARS } from './search';

const doc = {
  messageId: 'm1',
  userId: 'u1',
  accountId: 'a1',
  threadId: 't1',
  folder: 'INBOX',
  role: 'inbox',
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
  it('carries a whole message to upsert, or just its id to delete', () => {
    expect(indexPayloadSchema.parse({ op: 'upsert', doc }).op).toBe('upsert');
    expect(indexPayloadSchema.parse({ op: 'delete', messageId: 'm1' })).toEqual({
      op: 'delete',
      messageId: 'm1',
    });
  });

  it('rejects an uncut body and unknown roles', () => {
    const long = { ...doc, body: 'x'.repeat(MAX_INDEXED_BODY_CHARS + 1) };
    expect(indexPayloadSchema.safeParse({ op: 'upsert', doc: long }).success).toBe(false);
    expect(
      indexPayloadSchema.safeParse({ op: 'upsert', doc: { ...doc, role: 'nowhere' } }).success,
    ).toBe(false);
  });
});
