import { randomUUID } from 'node:crypto';
import {
  createJobEnvelope,
  type FolderRole,
  type MailboxOpPayload,
  type MailboxTarget,
} from '@onebox/contracts';
import { ConflictError, NotFoundError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { safeFetch } from '@onebox/net-guard';
import type { Producer } from '@onebox/queue';
import type { AnyBulkWriteOperation } from 'mongodb';
import type { MailCollections, MessageDoc } from '../db/collections';
import { locationOf, refreshThread } from '../threads/thread-store';

export const THREAD_ACTIONS = [
  'read',
  'unread',
  'star',
  'unstar',
  'archive',
  'trash',
  'move',
  'delete',
] as const;

export type ThreadAction = (typeof THREAD_ACTIONS)[number];

// The folder or label the user is looking at; moves take the messages shown there.
export type MailboxView = { role: FolderRole } | { label: string };

export interface ThreadActionInput {
  threadIds: string[];
  action: ThreadAction;
  from?: MailboxView | undefined;
  to?: MailboxTarget | undefined;
}

const MAX_UIDS_PER_OP = 1000;

// Like Gmail, moves wait this long before reaching the server, so they can be undone.
export const UNDO_WINDOW_MS = 6000;

export type OneClickPost = (url: string) => Promise<{ ok: boolean; status: number }>;

// RFC 8058: the sender's endpoint unsubscribes on this exact POST, no page or cookies needed.
const oneClickPost: OneClickPost = (url) =>
  safeFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    timeoutMs: 10_000,
  });

type Op = MailboxOpPayload['op'];

export function createThreadActions({
  collections,
  ops,
  logger,
  post = oneClickPost,
  undoWindowMs = UNDO_WINDOW_MS,
}: {
  collections: MailCollections;
  ops: Producer<MailboxOpPayload>;
  logger: Logger;
  post?: OneClickPost;
  undoWindowMs?: number;
}) {
  const { messages, threads } = collections;

  // One job per server folder, so each runs as a single IMAP command. Returns the job ids.
  async function send(userId: string, docs: MessageDoc[], op: Op, delayMs = 0) {
    const jobIds: string[] = [];
    const groups = new Map<string, MessageDoc[]>();
    for (const doc of docs) {
      const key = JSON.stringify([doc.accountId, doc.folder, doc.uidValidity]);
      groups.set(key, [...(groups.get(key) ?? []), doc]);
    }
    for (const group of groups.values()) {
      const { accountId, folder, uidValidity } = group[0]!;
      const uids = [...new Set(group.map((doc) => doc.uid))];
      for (let i = 0; i < uids.length; i += MAX_UIDS_PER_OP) {
        const jobId = randomUUID();
        jobIds.push(jobId);
        await ops.enqueue(
          createJobEnvelope({
            jobId,
            userId,
            accountId,
            payload: { folder, uidValidity, uids: uids.slice(i, i + MAX_UIDS_PER_OP), op },
          }),
          { delayMs },
        );
      }
    }
    return jobIds;
  }

  const inView = (view: MailboxView) => (doc: MessageDoc) => {
    const where = locationOf(doc);
    return 'role' in view
      ? where.role === view.role
      : where.role === 'label' && where.folder === view.label;
  };

  const sameTarget = (doc: MessageDoc, to: MailboxTarget) =>
    'role' in to ? inView({ role: to.role })(doc) : inView({ label: to.label })(doc);

  return {
    async apply(userId: string, { threadIds, action, from, to }: ThreadActionInput) {
      const ids = [...new Set(threadIds)];
      const owned = await threads.countDocuments({ _id: { $in: ids }, userId });
      if (owned !== ids.length) throw new NotFoundError('Conversation not found');

      const docs = (
        await messages
          .find({ userId, threadId: { $in: ids } })
          .sort({ receivedAt: 1 })
          .toArray()
      ).filter((doc) => locationOf(doc).role !== 'deleted');
      const now = new Date();
      const writes: AnyBulkWriteOperation<MessageDoc>[] = [];
      const mark = (targets: MessageDoc[], set: Partial<MessageDoc>) => {
        for (const doc of targets) {
          writes.push({
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: { ...set, pendingSince: now } },
            },
          });
        }
      };
      let targets: MessageDoc[] = [];
      let op: Op;

      switch (action) {
        case 'read':
        case 'unread': {
          const isRead = action === 'read';
          targets = docs.filter((doc) => doc.isRead !== isRead);
          mark(targets, { isRead });
          op = { type: 'flags', add: isRead ? ['\\Seen'] : [], remove: isRead ? [] : ['\\Seen'] };
          break;
        }
        case 'star': {
          // Like Gmail, starring a conversation stars its latest message.
          const latest = new Map<string, MessageDoc>();
          for (const doc of docs) latest.set(doc.threadId, doc);
          targets = [...latest.values()].filter((doc) => !doc.isStarred);
          mark(targets, { isStarred: true });
          op = { type: 'flags', add: ['\\Flagged'], remove: [] };
          break;
        }
        case 'unstar':
          targets = docs.filter((doc) => doc.isStarred);
          mark(targets, { isStarred: false });
          op = { type: 'flags', add: [], remove: ['\\Flagged'] };
          break;
        case 'archive':
          targets = docs.filter(inView({ role: 'inbox' }));
          mark(targets, { movingTo: { role: 'archive', folder: null } });
          op = { type: 'move', to: { role: 'archive' } };
          break;
        case 'trash':
          targets = docs.filter((doc) => locationOf(doc).role !== 'trash');
          mark(targets, { movingTo: { role: 'trash', folder: null } });
          op = { type: 'move', to: { role: 'trash' } };
          break;
        case 'move': {
          if (!to) throw new ValidationError('Choose where to move the conversation');
          targets = docs
            .filter(inView(from ?? { role: 'inbox' }))
            .filter((doc) => !sameTarget(doc, to));
          mark(
            targets,
            'role' in to
              ? { movingTo: { role: to.role, folder: null } }
              : { movingTo: { role: 'label', folder: to.label } },
          );
          op = { type: 'move', to };
          break;
        }
        case 'delete':
          targets = docs.filter((doc) => ['trash', 'spam'].includes(locationOf(doc).role));
          if (targets.length === 0) {
            throw new ValidationError('Only conversations in Trash or Spam can be deleted forever');
          }
          mark(targets, { movingTo: { role: 'deleted', folder: null } });
          op = { type: 'expunge' };
          break;
      }

      if (writes.length > 0) await messages.bulkWrite(writes);
      // Moves act on where the server has the message, not where OneBox shows it.
      const undoable = op.type === 'move' && targets.length > 0;
      const jobIds = await send(userId, targets, op, undoable ? undoWindowMs : 0);
      for (const id of ids) await refreshThread(collections, id);
      if (targets.length > 0) {
        logger.info(
          { action, conversations: ids.length, messages: targets.length },
          'conversation action queued',
        );
      }
      return {
        threads: await threads.find({ _id: { $in: ids }, userId }).toArray(),
        undoToken: undoable ? jobIds.join(',') : null,
      };
    },

    // Withdraws a move still inside its undo window and puts the mail back where it was shown.
    async undo(userId: string, undoToken: string) {
      const withdrawn = await ops.cancel(
        undoToken.split(','),
        (envelope) => envelope.userId === userId,
      );
      if (!withdrawn) {
        throw new ConflictError('Too late to undo: the change already reached the server.', {
          code: 'UNDO_EXPIRED',
        });
      }
      const touched = new Set<string>();
      for (const { accountId, payload } of withdrawn) {
        const filter = {
          userId,
          accountId,
          folder: payload.folder,
          uidValidity: payload.uidValidity,
          uid: { $in: payload.uids },
        };
        for (const doc of await messages.find(filter, { projection: { threadId: 1 } }).toArray()) {
          touched.add(doc.threadId);
        }
        await messages.updateMany(filter, { $set: { movingTo: null, pendingSince: null } });
      }
      for (const id of touched) await refreshThread(collections, id);
      logger.info({ conversations: touched.size }, 'conversation action undone');
      return [...touched];
    },

    // One-click where the sender supports it; otherwise the link or address for the user to use.
    async unsubscribe(userId: string, threadId: string) {
      const thread = await threads.findOne({ _id: threadId, userId });
      if (!thread) throw new NotFoundError('Conversation not found');
      const [latest] = await messages
        .find({ userId, threadId, unsubscribe: { $ne: null } })
        .sort({ receivedAt: -1 })
        .limit(1)
        .toArray();
      const option = latest?.unsubscribe;
      if (!option) throw new ValidationError('This conversation has no unsubscribe option');

      if (option.oneClick && option.url) {
        try {
          const response = await post(option.url);
          if (response.ok) {
            await threads.updateOne({ _id: threadId }, { $set: { unsubscribedAt: new Date() } });
            logger.info({ threadId }, 'unsubscribed with one click');
            return { method: 'one-click' as const, url: null };
          }
          logger.warn({ threadId, status: response.status }, 'one-click unsubscribe refused');
        } catch (err) {
          logger.warn({ threadId, err: (err as Error).message }, 'one-click unsubscribe failed');
        }
      }
      return option.url
        ? { method: 'link' as const, url: option.url }
        : { method: 'mailto' as const, url: option.mailto };
    },
  };
}

export type ThreadActions = ReturnType<typeof createThreadActions>;
