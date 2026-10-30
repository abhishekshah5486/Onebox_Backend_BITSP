import type { ChangeStreamDocument } from 'mongodb';
import { Timestamp } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { MessageDoc } from '../db/collections';
import { storedMessage } from '../test/fixtures';
import { changedCopy, searchKey, toSearchDocument, versionOf } from './search-feed';

type Indexed = Omit<MessageDoc, 'htmlBody'>;

const update = (fields: Record<string, unknown>, doc: Indexed | null = storedMessage()) =>
  ({
    operationType: 'update',
    documentKey: { _id: 'm1' },
    updateDescription: { updatedFields: fields, removedFields: [] },
    fullDocument: doc,
  }) as unknown as ChangeStreamDocument<Indexed>;

describe('searchKey', () => {
  it('is the same for every folder copy of an email, and differs per account', () => {
    const inbox = storedMessage({ _id: 'm1', messageIdHeader: '<x@acme>' });
    const allMail = storedMessage({ _id: 'm2', messageIdHeader: '<x@acme>', role: 'archive' });
    expect(searchKey(inbox)).toBe(searchKey(allMail));
    expect(searchKey({ ...inbox, accountId: 'a2' })).not.toBe(searchKey(inbox));
  });

  it('keeps copies without a Message-ID apart', () => {
    const a = storedMessage({ _id: 'm1', messageIdHeader: null });
    const b = storedMessage({ _id: 'm2', messageIdHeader: null });
    expect(searchKey(a)).not.toBe(searchKey(b));
  });
});

describe('versionOf', () => {
  it('orders cluster times', () => {
    const earlier = versionOf(new Timestamp({ t: 100, i: 999 }));
    const later = versionOf(new Timestamp({ t: 101, i: 0 }));
    expect(later).toBeGreaterThan(earlier);
    expect(Number.isSafeInteger(versionOf(new Timestamp({ t: 2_000_000_000, i: 5 })))).toBe(true);
  });
});

describe('toSearchDocument', () => {
  it('keeps what search needs: real attachments only, falling back to the snippet', () => {
    expect(toSearchDocument([storedMessage()])).toMatchObject({
      copies: [{ messageId: 'm1', folder: 'INBOX', role: 'inbox' }],
      body: 'Sharing the quote for 20 seats.',
      attachmentNames: ['quote.pdf'],
      labels: ['Sales'],
      receivedAt: '2026-10-30T10:00:00.000Z',
    });
    expect(toSearchDocument([storedMessage({ textBody: '' })]).body).toBe('Sharing the quote');
  });

  it('merges folder copies into one email, whatever order they come in', () => {
    const inbox = storedMessage({ _id: 'm1', messageIdHeader: '<x@acme>', isRead: true });
    const label = storedMessage({
      _id: 'm2',
      messageIdHeader: '<x@acme>',
      folder: 'Receipts',
      role: 'label',
      isRead: false,
      isStarred: false,
      aiLabels: ['Finance'],
    });
    const merged = toSearchDocument([label, inbox]);
    expect(merged).toEqual(toSearchDocument([inbox, label]));
    expect(merged).toMatchObject({
      key: searchKey(inbox),
      copies: [
        { messageId: 'm1', folder: 'INBOX', role: 'inbox' },
        { messageId: 'm2', folder: 'Receipts', role: 'label' },
      ],
      labels: ['Sales', 'Finance'],
      isRead: false,
      isStarred: true,
    });
  });
});

describe('changedCopy', () => {
  it('rebuilds on content or flag changes, but not on sync bookkeeping', () => {
    expect(changedCopy(update({ isRead: true }))).toEqual({ changed: storedMessage() });
    expect(changedCopy(update({ pendingSince: new Date(), movingTo: null }))).toBeNull();
  });

  it('leaves a copy deleted since its update to that delete', () => {
    expect(changedCopy(update({ isRead: true }, null))).toBeNull();
  });

  it('names a removed copy by id', () => {
    const change = {
      operationType: 'delete',
      documentKey: { _id: 'm9' },
    } as unknown as ChangeStreamDocument<Indexed>;
    expect(changedCopy(change)).toEqual({ removed: 'm9' });
  });
});
