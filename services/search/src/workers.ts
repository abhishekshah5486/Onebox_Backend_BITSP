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
import type { Embed } from './semantic/vector-index';
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
        for (const { model, index, entry } of await models.targets(doc.userId)) {
          await index.upsert(doc, version, (texts) =>
            embed({ userId: doc.userId, texts, charge: false, model: model.id }),
          );
          await models.noteBackup(doc.userId, entry);
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

// The same text is embedded once, however many stores take it.
function sharedEmbed(embed: Embed): Embed {
  const done = new Map<string, Promise<number[]>>();
  return async (texts) => {
    const missing = [...new Set(texts.filter((text) => !done.has(text)))];
    if (missing.length) {
      const vectors = embed(missing);
      missing.forEach((text, i) =>
        done.set(
          text,
          vectors.then((all) => all[i]!),
        ),
      );
    }
    return Promise.all(texts.map((text) => done.get(text)!));
  };
}

// Two kinds of job. Without a store: embed all of a user's mail with the model they switched to,
// in every store that isn't paused, then move their searches to it; a newer switch makes it moot.
// With a store: catch that store up with the model in use, e.g. once it's added or resumed.
// Either way, a restarted job skips what is already embedded.
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
  const embedWith = (userId: string, modelId: string) => (texts: string[]) =>
    embed({ userId, texts, charge: false, model: modelId });

  async function switchModel(userId: string, modelId: string) {
    const isCurrent = async () => (await models.chosen(userId, { fresh: true })).id === modelId;
    if (!(await isCurrent())) return;
    const model = await models.chosen(userId);
    const setup = await models.setupOf(userId, { fresh: true });
    const stores = setup.stores.filter((entry) => !entry.paused);
    const indexes = await Promise.all(stores.map((entry) => models.indexFor(model, entry.store)));
    await models.startRebuild(userId, model.id, await keyword.countOf(userId));
    let embedded = 0;
    for await (const page of keyword.documentsOf(userId, REBUILD_BATCH)) {
      if (!(await isCurrent())) return;
      const once = sharedEmbed(embedWith(userId, model.id));
      for (const index of indexes) embedded += await index.upsertMany(page, once);
      await models.progress(userId, page.length);
    }
    await models.finishRebuild(userId, model, stores);
    logger.info(
      { userId, model: model.id, stores: stores.length, embedded },
      'mail embedded with the new model',
    );
  }

  async function catchUp(userId: string, modelId: string, storeId: string) {
    const current = async () => {
      const setup = await models.setupOf(userId, { fresh: true });
      const entry = setup.stores.find((candidate) => candidate.id === storeId);
      const model = await models.active(userId);
      return entry && !entry.paused && model.id === modelId ? { entry, model } : null;
    };
    const start = await current();
    if (!start) return;
    const { entry, model } = start;
    const index = await models.indexFor(model, entry.store);
    await models.startCatchup(userId, entry, model.id, await keyword.countOf(userId));
    let embedded = 0;
    try {
      for await (const page of keyword.documentsOf(userId, REBUILD_BATCH)) {
        // Paused, removed, given new settings or a new model meanwhile: this job is moot.
        if ((await current())?.entry.store.id !== entry.store.id) {
          await models.abandonCatchup(userId, entry, model.id);
          return;
        }
        embedded += await index.upsertMany(page, embedWith(userId, model.id));
        await models.catchupProgress(userId, entry, page.length);
      }
    } catch (err) {
      await models.abandonCatchup(userId, entry, model.id);
      throw err;
    }
    await models.finishCatchup(userId, entry, model);
    logger.info({ userId, model: model.id, store: storeId, embedded }, 'store caught up');
  }

  return async ({ userId, payload }: JobEnvelope<ReembedPayload>) =>
    payload.storeId
      ? catchUp(userId, payload.modelId, payload.storeId)
      : switchModel(userId, payload.modelId);
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
