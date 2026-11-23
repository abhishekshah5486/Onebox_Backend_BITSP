import { createJobEnvelope, type MailboxOpPayload } from '@onebox/contracts';
import type { Producer } from '@onebox/queue';
import { randomUUID } from 'node:crypto';
import type { MessageDoc } from '../db/collections';

// Queues labels for the server to put on one copy of the message; on Gmail a label covers
// every copy, and the connector leaves servers without labels alone.
export const labelWriter =
  (ops: Producer<MailboxOpPayload>) => async (doc: MessageDoc, add: string[], remove: string[]) => {
    await ops.enqueue(
      createJobEnvelope<MailboxOpPayload>({
        jobId: randomUUID(),
        userId: doc.userId,
        accountId: doc.accountId,
        payload: {
          folder: doc.folder,
          uidValidity: doc.uidValidity,
          uids: [doc.uid],
          op: { type: 'labels', add, remove },
        },
      }),
    );
  };
