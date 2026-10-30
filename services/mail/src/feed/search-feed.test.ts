import type { ChangeStreamDocument } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { MessageDoc } from '../db/collections';
import { storedMessage } from '../test/fixtures';
import { indexPayloadOf, toSearchDocument } from './search-feed';

type Indexed = Omit<MessageDoc, 'htmlBody'>;

const update = (fields: Record<string, unknown>, doc = storedMessage()) =>
  ({
    operationType: 'update',
    documentKey: { _id: doc._id },
    updateDescription: { updatedFields: fields, removedFields: [] },
    fullDocument: doc,
  }) as unknown as ChangeStreamDocument<Indexed>;

describe('toSearchDocument', () => {
  it('keeps what search needs: real attachments only, and a label folder as a label', () => {
    const doc = toSearchDocument(storedMessage({ role: 'label', folder: 'Receipts' }));
    expect(doc).toMatchObject({
      messageId: 'm1',
      body: 'Sharing the quote for 20 seats.',
      attachmentNames: ['quote.pdf'],
      labels: ['Sales', 'Receipts'],
      receivedAt: '2026-10-30T10:00:00.000Z',
    });
  });

  it('falls back to the snippet when there is no plain-text body', () => {
    expect(toSearchDocument(storedMessage({ textBody: '' })).body).toBe('Sharing the quote');
  });
});

describe('indexPayloadOf', () => {
  it('reindexes on content or flag changes, but not on sync bookkeeping', () => {
    expect(indexPayloadOf(update({ isRead: true }))?.op).toBe('upsert');
    expect(indexPayloadOf(update({ pendingSince: new Date(), movingTo: null }))).toBeNull();
  });

  it('drops deleted mail by id', () => {
    const change = {
      operationType: 'delete',
      documentKey: { _id: 'm9' },
    } as unknown as ChangeStreamDocument<Indexed>;
    expect(indexPayloadOf(change)).toEqual({ op: 'delete', messageId: 'm9' });
  });
});
