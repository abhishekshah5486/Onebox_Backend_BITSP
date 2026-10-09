import { createJobEnvelope, type MailboxChangePayload } from '@onebox/contracts';
import { NotFoundError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Producer } from '@onebox/queue';
import { randomUUID } from 'node:crypto';
import type { AiCollections, ClassificationDoc, LabelResult } from '../db/collections';

const PAGE_SIZE = 50;

const toView = (doc: ClassificationDoc) => ({
  messageId: doc._id,
  threadId: doc.threadId,
  accountId: doc.accountId,
  from: doc.from,
  subject: doc.subject,
  receivedAt: doc.receivedAt.toISOString(),
  model: doc.model,
  results: doc.results,
});

// AI's "suggest" picks waiting for the user: accept, reject, or put on a different label.
export function createSuggestions({
  collections,
  changes,
  logger,
}: {
  collections: AiCollections;
  changes: Producer<MailboxChangePayload>;
  logger: Logger;
}) {
  const { classifications, feedback } = collections;

  async function owned(userId: string, messageId: string) {
    const doc = await classifications.findOne({ _id: messageId, userId });
    if (!doc) throw new NotFoundError('Suggestion not found');
    return doc;
  }

  async function tag(doc: ClassificationDoc, add: string[], remove: string[] = []) {
    await changes.enqueue(
      createJobEnvelope({
        jobId: randomUUID(),
        userId: doc.userId,
        accountId: doc.accountId,
        payload: { type: 'tagged', messageId: doc._id, add, remove },
      }),
    );
  }

  async function save(doc: ClassificationDoc, results: LabelResult[]) {
    await classifications.updateOne(
      { _id: doc._id },
      {
        $set: {
          results,
          pending: results.some((result) => result.status === 'pending'),
          updatedAt: new Date(),
        },
      },
    );
    return toView({ ...doc, results });
  }

  const remember = (
    doc: ClassificationDoc,
    path: string,
    verdict: 'accepted' | 'rejected' | 'assigned',
  ) =>
    feedback.insertOne({
      userId: doc.userId,
      accountId: doc.accountId,
      messageId: doc._id,
      path,
      verdict,
      subject: doc.subject,
      createdAt: new Date(),
    });

  return {
    // Waiting suggestions, or past ones: what was decided and what AI labelled on its own.
    async list(userId: string, page = 1, view: 'waiting' | 'past' = 'waiting') {
      const filter =
        view === 'waiting'
          ? { userId, pending: true }
          : { userId, pending: false, 'results.0': { $exists: true } };
      const [items, total] = await Promise.all([
        classifications
          .find(filter)
          .sort({ receivedAt: -1 })
          .skip((page - 1) * PAGE_SIZE)
          .limit(PAGE_SIZE)
          .toArray(),
        classifications.countDocuments(filter),
      ]);
      return { items: items.map(toView), page, pageSize: PAGE_SIZE, total };
    },

    count: (userId: string) => classifications.countDocuments({ userId, pending: true }),

    async decide(userId: string, messageId: string, path: string, accept: boolean) {
      const doc = await owned(userId, messageId);
      const result = doc.results.find((item) => item.path === path && item.status === 'pending');
      if (!result) throw new ValidationError('That suggestion was already handled');
      const verdict = accept ? 'accepted' : 'rejected';
      const view = await save(
        doc,
        doc.results.map((item) => (item === result ? { ...item, status: verdict } : item)),
      );
      if (accept) await tag(doc, [path]);
      await remember(doc, path, verdict);
      logger.info({ verdict }, 'suggestion decided');
      return view;
    },

    // Dropped without a verdict: nothing is labelled and nothing is learned from it.
    async discard(userId: string, messageId: string) {
      const doc = await owned(userId, messageId);
      return save(
        doc,
        doc.results.map((item) =>
          item.status === 'pending' ? { ...item, status: 'discarded' as const } : item,
        ),
      );
    },

    // The user files it under another label instead: open suggestions are declined.
    async assign(userId: string, messageId: string, path: string, name: string) {
      const doc = await owned(userId, messageId);
      const results: LabelResult[] = [
        ...doc.results.map((item) =>
          item.status === 'pending' ? { ...item, status: 'rejected' as const } : item,
        ),
        ...(doc.results.some((item) => item.path === path && item.status !== 'rejected')
          ? []
          : [{ path, name, confidence: 1, reason: 'Chosen by you', status: 'assigned' as const }]),
      ];
      const view = await save(doc, results);
      await tag(doc, [path]);
      await remember(doc, path, 'assigned');
      return view;
    },
  };
}

export type Suggestions = ReturnType<typeof createSuggestions>;
