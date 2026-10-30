import { indexPayloadSchema, QUEUES, type IndexPayload, type JobEnvelope } from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import { createConsumer } from '@onebox/queue';
import type { EmbedClient } from './clients/embed-client';
import type { KeywordIndex } from './keyword/keyword-index';
import type { VectorIndex } from './semantic/vector-index';

export function keywordHandler(keyword: KeywordIndex) {
  return async ({ payload }: JobEnvelope<IndexPayload>) => {
    if (payload.op === 'upsert') await keyword.upsert(payload.doc);
    else await keyword.remove(payload.messageId);
  };
}

export function vectorHandler(vector: VectorIndex, embed: EmbedClient) {
  return async ({ payload }: JobEnvelope<IndexPayload>) => {
    if (payload.op === 'delete') {
      await vector.remove(payload.messageId);
      return;
    }
    const { doc } = payload;
    await vector.upsert(doc, (texts) => embed({ userId: doc.userId, texts, charge: false }));
  };
}

export interface WorkerDeps {
  redisUrl: string;
  logger: Logger;
  keyword: KeywordIndex;
  vector: VectorIndex;
  embed: EmbedClient;
  indexConcurrency: number;
  embedConcurrency: number;
}

export function startWorkers(deps: WorkerDeps) {
  const { redisUrl, logger } = deps;
  const consumers = [
    createConsumer(QUEUES.index, indexPayloadSchema, keywordHandler(deps.keyword), {
      redisUrl,
      logger,
      concurrency: deps.indexConcurrency,
    }),
    createConsumer(QUEUES.embed, indexPayloadSchema, vectorHandler(deps.vector, deps.embed), {
      redisUrl,
      logger,
      concurrency: deps.embedConcurrency,
    }),
  ];
  return { close: () => Promise.all(consumers.map((consumer) => consumer.close())) };
}
