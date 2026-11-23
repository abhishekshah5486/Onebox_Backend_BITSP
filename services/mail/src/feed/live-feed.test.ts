import type { ChangeStreamDocument } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { ThreadDoc } from '../db/collections';
import { liveEventOf } from './live-feed';

const thread = { _id: 't1', userId: 'u1', accountId: 'a1' } as ThreadDoc;

describe('liveEventOf', () => {
  it('tells the owner a conversation changed, or went away', () => {
    const changed = {
      operationType: 'update',
      fullDocument: thread,
    } as ChangeStreamDocument<ThreadDoc>;
    expect(liveEventOf(changed)).toEqual({
      userId: 'u1',
      event: { type: 'thread.changed', threadId: 't1', accountId: 'a1' },
    });
    const removed = {
      operationType: 'delete',
      fullDocumentBeforeChange: thread,
    } as unknown as ChangeStreamDocument<ThreadDoc>;
    expect(liveEventOf(removed)).toEqual({
      userId: 'u1',
      event: { type: 'thread.removed', threadId: 't1' },
    });
  });

  it('skips a delete whose owner is unknown', () => {
    const removed = { operationType: 'delete' } as unknown as ChangeStreamDocument<ThreadDoc>;
    expect(liveEventOf(removed)).toBeNull();
  });
});
