import { createHash } from 'node:crypto';
import {
  createJobEnvelope,
  FOLDER_ROLES,
  HISTORY_BATCH_SIZE,
  type HistoryPayload,
  mailboxKey,
} from '@onebox/contracts';
import { ConflictError, NotFoundError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { MailboxStore } from '@onebox/mailbox-state';
import type { Producer } from '@onebox/queue';
import type { Filter } from 'mongodb';
import type { MailCollections, MessageDoc, ThreadDoc } from '../db/collections';
import type { MailboxView } from './thread-actions';

const INBOX: MailboxView = { role: 'inbox' };

const keyOf = (view: MailboxView) =>
  'label' in view ? mailboxKey('label', view.label) : view.role;
const storedIn = (view: MailboxView): Filter<MessageDoc> =>
  'label' in view ? { role: 'label', folder: view.label } : { role: view.role };
const shownIn = (view: MailboxView): Filter<ThreadDoc> =>
  'label' in view ? { labels: view.label } : { folders: view.role };
const nameOf = (path: string) => path.split('/').at(-1) ?? path;

export interface MailboxDeps {
  collections: MailCollections;
  store: MailboxStore;
  historyProducer: Producer<HistoryPayload>;
  logger: Logger;
}

export function createMailboxService({ collections, store, historyProducer, logger }: MailboxDeps) {
  const { messages, threads } = collections;

  async function load(userId: string, accountId: string, view: MailboxView) {
    const [counts, history] = await Promise.all([
      store.getCounts(accountId, keyOf(view)),
      store.getHistory(accountId, keyOf(view)),
    ]);
    // Counts carry the owner, so another user's mailbox is reported as missing.
    if (counts && counts.userId !== userId) throw new NotFoundError('Mailbox not found');
    return { counts, history };
  }

  async function summary(userId: string, accountId: string, view: MailboxView = INBOX) {
    const { counts, history } = await load(userId, accountId, view);
    const [conversations, stored] = await Promise.all([
      threads.countDocuments({ userId, accountId, ...shownIn(view) }),
      messages.countDocuments({ userId, accountId, ...storedIn(view) }),
    ]);
    const status = history?.status ?? 'idle';
    return {
      accountId,
      folder: 'label' in view ? ('label' as const) : view.role,
      label: 'label' in view ? view.label : null,
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

    // Folders and labels the connector has found on the server, with their server-side counts.
    async folders(userId: string, accountId: string) {
      const [all, labels] = await Promise.all([
        Promise.all(FOLDER_ROLES.map((role) => store.getCounts(accountId, role))),
        store.getLabels(accountId),
      ]);
      const found = all.filter((counts) => counts !== null);
      if (found.some((counts) => counts.userId !== userId)) {
        throw new NotFoundError('Mailbox not found');
      }
      // Labels are only listed once a folder of the same account proves who owns it.
      const labelCounts =
        found.length > 0
          ? await Promise.all(
              labels.map((label) => store.getCounts(accountId, keyOf({ label: label.path }))),
            )
          : [];
      return {
        items: [
          ...found.map(({ role, folder, total, unread, updatedAt }) => ({
            role,
            path: folder,
            name: nameOf(folder),
            total,
            unread,
            updatedAt,
          })),
          ...labelCounts.map((counts, i) => ({
            role: 'label' as const,
            path: labels[i]!.path,
            name: labels[i]!.name,
            total: counts?.total ?? 0,
            unread: counts?.unread ?? 0,
            updatedAt: counts?.updatedAt ?? new Date(0).toISOString(),
          })),
        ],
      };
    },

    // Asks the connector for the page of mail just older than the oldest message stored here.
    async requestHistory(userId: string, accountId: string, view: MailboxView = INBOX) {
      const { counts, history } = await load(userId, accountId, view);
      if (!counts) {
        throw new ConflictError('This mailbox is still syncing. Try again in a moment.', {
          code: 'MAILBOX_NOT_READY',
        });
      }
      if (history?.status === 'fetching' || history?.status === 'complete')
        return summary(userId, accountId, view);

      const [oldest] = await messages
        .find({ userId, accountId, ...storedIn(view), uidValidity: counts.uidValidity })
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
          jobId: `${accountId}-${createHash('sha256').update(keyOf(view)).digest('hex').slice(0, 16)}-${counts.uidValidity}-${oldest.uid}`,
          userId,
          accountId,
          payload: {
            folder: counts.folder,
            role: counts.role,
            uidValidity: counts.uidValidity,
            beforeUid: oldest.uid,
            count: HISTORY_BATCH_SIZE,
          },
        }),
        { retryFailed: true },
      );
      await store.setHistory(accountId, keyOf(view), 'fetching');
      logger.info({ accountId, view, beforeUid: oldest.uid }, 'older mail requested');
      return summary(userId, accountId, view);
    },
  };
}

export type MailboxService = ReturnType<typeof createMailboxService>;
