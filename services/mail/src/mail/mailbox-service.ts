import { createJobEnvelope, HISTORY_BATCH_SIZE, type HistoryPayload } from '@onebox/contracts';
import { ConflictError, NotFoundError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { MailboxStore } from '@onebox/mailbox-state';
import type { Producer } from '@onebox/queue';
import type { MailCollections } from '../db/collections';

const FOLDER = 'INBOX';

export interface MailboxDeps {
  collections: MailCollections;
  store: MailboxStore;
  historyProducer: Producer<HistoryPayload>;
  logger: Logger;
}

export function createMailboxService({ collections, store, historyProducer, logger }: MailboxDeps) {
  const { messages, threads } = collections;

  async function load(userId: string, accountId: string) {
    const [counts, history] = await Promise.all([
      store.getCounts(accountId, FOLDER),
      store.getHistory(accountId, FOLDER),
    ]);
    // Counts carry the owner, so another user's mailbox is reported as missing.
    if (counts && counts.userId !== userId) throw new NotFoundError('Mailbox not found');
    return { counts, history };
  }

  async function summary(userId: string, accountId: string) {
    const { counts, history } = await load(userId, accountId);
    const [conversations, stored] = await Promise.all([
      threads.countDocuments({ userId, accountId }),
      messages.countDocuments({ userId, accountId, folder: FOLDER }),
    ]);
    const status = history?.status ?? 'idle';
    return {
      accountId,
      server: counts
        ? { total: counts.total, unread: counts.unread, updatedAt: counts.updatedAt }
        : null,
      fetched: { conversations, messages: stored },
      history: { status, error: history?.error ?? null },
      hasMoreOnServer: status !== 'complete' && counts !== null && stored < counts.total,
    };
  }

  return {
    summary,

    // Asks the connector for the page of mail just older than the oldest message stored here.
    async requestHistory(userId: string, accountId: string) {
      const { counts, history } = await load(userId, accountId);
      if (!counts) {
        throw new ConflictError('This mailbox is still syncing. Try again in a moment.', {
          code: 'MAILBOX_NOT_READY',
        });
      }
      if (history?.status === 'fetching' || history?.status === 'complete')
        return summary(userId, accountId);

      const [oldest] = await messages
        .find({ userId, accountId, folder: FOLDER, uidValidity: counts.uidValidity })
        .sort({ uid: 1 })
        .limit(1)
        .project<{ uid: number }>({ uid: 1 })
        .toArray();
      if (!oldest) {
        throw new ConflictError('This mailbox is still syncing. Try again in a moment.', {
          code: 'MAILBOX_NOT_READY',
        });
      }

      await historyProducer.enqueue(
        createJobEnvelope({
          jobId: `${accountId}-${counts.uidValidity}-${oldest.uid}`,
          userId,
          accountId,
          payload: {
            folder: FOLDER,
            uidValidity: counts.uidValidity,
            beforeUid: oldest.uid,
            count: HISTORY_BATCH_SIZE,
          },
        }),
        { retryFailed: true },
      );
      await store.setHistory(accountId, FOLDER, 'fetching');
      logger.info({ accountId, beforeUid: oldest.uid }, 'older mail requested');
      return summary(userId, accountId);
    },
  };
}

export type MailboxService = ReturnType<typeof createMailboxService>;
