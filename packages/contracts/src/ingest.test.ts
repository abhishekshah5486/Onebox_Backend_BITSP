import { describe, expect, it } from 'vitest';
import { ingestDedupeKey, ingestPayloadSchema } from './ingest';

const coordinates = { accountId: 'a1', folder: 'INBOX', uidValidity: 7, uid: 42 };

describe('ingestDedupeKey', () => {
  it('is stable for the same message', () => {
    expect(ingestDedupeKey(coordinates)).toBe(ingestDedupeKey({ ...coordinates }));
    expect(ingestDedupeKey(coordinates)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([{ accountId: 'a2' }, { folder: 'Sent' }, { uidValidity: 8 }, { uid: 43 }])(
    'changes when %j changes',
    (change) => {
      expect(ingestDedupeKey({ ...coordinates, ...change })).not.toBe(ingestDedupeKey(coordinates));
    },
  );

  it('cannot be forged by shifting characters between fields', () => {
    expect(ingestDedupeKey({ ...coordinates, accountId: 'a1I', folder: 'NBOX' })).not.toBe(
      ingestDedupeKey(coordinates),
    );
  });
});

describe('ingestPayloadSchema', () => {
  const valid = {
    folder: 'INBOX',
    uid: 1,
    uidValidity: 7,
    flags: ['\\Seen'],
    internalDate: '2026-10-07T10:00:00.000Z',
    sizeBytes: 12,
    backfill: false,
    rawSource: Buffer.from('Subject: hi\r\n\r\nbody').toString('base64'),
  };

  it('accepts a well-formed payload, defaulting the folder role to inbox', () => {
    expect(ingestPayloadSchema.parse(valid)).toEqual({
      ...valid,
      role: 'inbox',
      category: null,
      categories: [],
    });
    expect(ingestPayloadSchema.parse({ ...valid, role: 'sent' }).role).toBe('sent');
  });

  it.each([{ uid: 0 }, { rawSource: 'not base64!' }, { internalDate: 'yesterday' }])(
    'rejects %j',
    (bad) => {
      expect(ingestPayloadSchema.safeParse({ ...valid, ...bad }).success).toBe(false);
    },
  );
});
