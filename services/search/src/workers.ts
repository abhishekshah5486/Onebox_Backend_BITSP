import {
  indexPayloadSchema,
  QUEUES,
  reembedPayloadSchema,
  type IndexPayload,
  type JobEnvelope,
  type ReembedPayload,
  type SearchDocument,
} from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import { createConsumer } from '@onebox/queue';
import type { EmbedClient } from './clients/embed-client';
import type { IndexState } from './index-state';
import type { KeywordIndex } from './keyword/keyword-index';
import type { SemanticModels } from './semantic/models';

// Emails embedded per call while rebuilding with a new model.
const REBUILD_BATCH = 32;

export interface Index {
  name: string;
  upsert(doc: SearchDocument, version: number): Promise<unknown>;
  removeCopy(key: string, messageId: string, version: number, userId: string): Promise<boolean>;
}

// One worker at a time per email, so a copy removal never undoes another; versions settle the
// rest, and removed copies stay out of any older write that lands later.
export function indexHandler(index: Index, state: IndexState) {
  return async ({ userId, payload }: JobEnvelope<IndexPayload>) => {
    if (payload.op === 'delete') {
      const key = await state.keyOfCopy(payload.messageId);
      await state.forgetCopy(payload.messageId, payload.version);
      if (key) {
        await state.withLock(`${index.name}:${key}`, () =>
          index.removeCopy(key, payload.messageId, payload.version, userId),
        );
      }
      return;
    }
    await state.withLock(`${index.name}:${payload.doc.key}`, async () => {
      const doc = await state.withoutRemoved(payload.doc, payload.version);
      if (!doc) return;
      await state.rememberCopies(doc);
      await index.upsert(doc, payload.version);
    });
  };
}

export const keywordHandler = (keyword: KeywordIndex, state: IndexState) =>
  indexHandler(
    {
      name: 'keyword',
      upsert: (doc, version) => keyword.upsert(doc, version),
      removeCopy: (key, messageId, version) => keyword.removeCopy(key, messageId, version),
    },
    state,
  );

// Indexing isn't charged to the user; only their searches are. Each model the user needs gets
// the email: the one they search with and, while switching, the one they picked.
export const vectorHandler = (models: SemanticModels, embed: EmbedClient, state: IndexState) =>
  indexHandler(
    {
      name: 'vector',
      async upsert(doc, version) {
        for (const { model, index } of await models.targets(doc.userId)) {
          await index.upsert(doc, version, (texts) =>
            embed({ userId: doc.userId, texts, charge: false, model: model.id }),
          );
        }
      },
      // A removal doesn't say which model the email was in, so every model's copy goes.
      async removeCopy(key, messageId, version, userId) {
        const results = await Promise.all(
          (await models.allIndexes(userId)).map((index) =>
            index.removeCopy(key, messageId, version, userId),
          ),
        );
        return results.some(Boolean);
      },
    },
    state,
  );

// Embeds all of a user's mail with the model they switched to, then moves their searches to it.
// A newer switch makes this one moot; a restarted rebuild skips what is already embedded.
export function reembedHandler({
  models,
  keyword,
  embed,
  logger,
}: {
  models: SemanticModels;
  keyword: Pick<KeywordIndex, 'countOf' | 'documentsOf'>;
  embed: EmbedClient;
  logger: Logger;
}) {
  return async ({ userId, payload }: JobEnvelope<ReembedPayload>) => {
    const isCurrent = async () =>
      (await models.chosen(userId, { fresh: true })).id === payload.modelId;
    if (!(await isCurrent())) return;
    const model = await models.chosen(userId);
    // Into the store the user has now; moving it again queues another rebuild.
    const store = await models.storeOf(userId, { fresh: true });
    const sameStore = async () => (await models.storeOf(userId, { fresh: true })).id === store.id;
    const index = await models.indexFor(model, store);
    await models.startRebuild(userId, model.id, await keyword.countOf(userId), store.id);
    let embedded = 0;
    for await (const page of keyword.documentsOf(userId, REBUILD_BATCH)) {
      if (!(await isCurrent()) || !(await sameStore())) return;
      embedded += await index.upsertMany(page, (texts) =>
        embed({ userId, texts, charge: false, model: model.id }),
      );
      await models.progress(userId, page.length);
    }
    await models.finishRebuild(userId, model, store);
    logger.info(
      { userId, model: model.id, store: store.id, embedded },
      'mail embedded with the new model',
    );
  };
}

export interface WorkerDeps {
  redisUrl: string;
  logger: Logger;
  keyword: KeywordIndex;
  models: SemanticModels;
  embed: EmbedClient;
  state: IndexState;
  indexConcurrency: number;
  embedConcurrency: number;
}

export function startWorkers(deps: WorkerDeps) {
  const { redisUrl, logger } = deps;
  const consumers = [
    createConsumer(QUEUES.index, indexPayloadSchema, keywordHandler(deps.keyword, deps.state), {
      redisUrl,
      logger,
      concurrency: deps.indexConcurrency,
    }),
    createConsumer(
      QUEUES.embed,
      indexPayloadSchema,
      vectorHandler(deps.models, deps.embed, deps.state),
      { redisUrl, logger, concurrency: deps.embedConcurrency },
    ),
    // One mailbox at a time, so a rebuild doesn't starve live indexing of the embedding model.
    createConsumer(
      QUEUES.reembed,
      reembedPayloadSchema,
      reembedHandler({ models: deps.models, keyword: deps.keyword, embed: deps.embed, logger }),
      { redisUrl, logger, concurrency: 1 },
    ),
  ];
  return { close: () => Promise.all(consumers.map((consumer) => consumer.close())) };
}
