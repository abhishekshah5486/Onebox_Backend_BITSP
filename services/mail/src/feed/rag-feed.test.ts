import { describe, expect, it } from 'vitest';
import { storedMessage } from '../test/fixtures';
import { emailKey } from './message-feed';
import { toRagJob } from './rag-feed';

describe('toRagJob', () => {
  const inbox = storedMessage({ _id: 'b', role: 'inbox', messageIdHeader: '<m1@x>' });
  const spam = storedMessage({ _id: 'a', role: 'spam', messageIdHeader: '<m1@x>' });

  it('names only the copies RAG reads, and drops the email once none is left', () => {
    const job = toRagJob({ kind: 'email', version: 7, copies: [inbox, spam] });
    expect(job).toEqual({
      userId: inbox.userId,
      payload: {
        op: 'upsert',
        version: 7,
        key: emailKey(inbox),
        accountId: inbox.accountId,
        messageIds: ['b'],
      },
    });
    const drafts = storedMessage({ _id: 'c', role: 'drafts', messageIdHeader: '<m1@x>' });
    expect(toRagJob({ kind: 'email', version: 8, copies: [spam, drafts] }).payload).toEqual({
      op: 'remove',
      version: 8,
      key: emailKey(spam),
      accountId: spam.accountId,
    });
  });

  it('passes a removed copy on by its id', () => {
    expect(toRagJob({ kind: 'removed', version: 9, messageId: 'b' })).toEqual({
      userId: 'system',
      payload: { op: 'delete', version: 9, messageId: 'b' },
    });
  });
});
