import type { MailboxOpPayload } from '@onebox/contracts';
import type { Producer } from '@onebox/queue';
import { describe, expect, it, vi } from 'vitest';
import type { MessageDoc } from '../db/collections';
import { labelWriter } from './write-labels';

describe('labelWriter', () => {
  it('queues the labels for the copy of the message it was given', async () => {
    const enqueue = vi.fn(async () => 'job');
    const ops = { enqueue } as unknown as Producer<MailboxOpPayload>;
    const doc = {
      userId: 'u1',
      accountId: 'a1',
      folder: '[Gmail]/All Mail',
      uidValidity: 3,
      uid: 42,
    } as MessageDoc;

    await labelWriter(ops)(doc, ['Leads'], ['Old']);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        accountId: 'a1',
        payload: {
          folder: '[Gmail]/All Mail',
          uidValidity: 3,
          uids: [42],
          op: { type: 'labels', add: ['Leads'], remove: ['Old'] },
        },
      }),
    );
  });
});
