import {
  indexPayloadSchema,
  QUEUES,
  type IndexPayload,
  type JobEnvelope,
  type SearchDocument,
} from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import { createConsumer } from '@onebox/queue';
import type { EmbedClient } from './clients/embed-client';
import type { IndexState } from './index-state';
import type { KeywordIndex } from './keyword/keyword-index';
import type { VectorIndex } from './semantic/vector-index';

export interface Index {
  name: string;
  upsert(doc: SearchDocument, version: number): Promise<unknown>;
  removeCopy(key: string, messageId: string, version: number): Promise<boolean>;
}

// One worker at a time per email, so a copy removal never undoes another; versions settle the
// rest, and removed copies stay out of any older write that lands later.
export function indexHandler(index: Index, state: IndexState) {
  return async ({ payload }: JobEnvelope<IndexPayload>) => {
    if (payload.op === 'delete') {
      const key = await state.keyOfCopy(payload.messageId);
      await state.forgetCopy(payload.messageId, payload.version);
      if (key) {
        await state.withLock(`${index.name}:${key}`, () =>
          index.removeCopy(key, payload.messageId, payload.version),
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

// Indexing isn't charged to the user; only their searches are.
export const vectorHandler = (vector: VectorIndex, embed: EmbedClient, state: IndexState) =>
  indexHandler(
    {
      name: 'vector',
      upsert: (doc, version) =>
        vector.upsert(doc, version, (texts) => embed({ userId: doc.userId, texts, charge: false })),
      removeCopy: (key, messageId, version) => vector.removeCopy(key, messageId, version),
    },
    state,
  );

export interface WorkerDeps {
  redisUrl: string;
  logger: Logger;
  keyword: KeywordIndex;
  vector: VectorIndex;
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
      vectorHandler(deps.vector, deps.embed, deps.state),
      { redisUrl, logger, concurrency: deps.embedConcurrency },
    ),
  ];
  return { close: () => Promise.all(consumers.map((consumer) => consumer.close())) };
}
