import { randomUUID } from 'node:crypto';
import {
  ExternalServiceError,
  PaymentRequiredError,
  ServiceUnavailableError,
} from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { postJson, ProviderError } from '../providers/types';
import type { Billing } from './billing';

// Shortened from 3072 dimensions: nearly the same quality at a third of Qdrant's memory.
export const EMBEDDING_MODEL = {
  id: 'openai/text-embedding-3-large',
  apiName: 'text-embedding-3-large',
  name: 'OpenAI Text Embedding 3 Large',
  dimensions: 1024,
  usdPerMillionTokens: 0.13,
};

export interface EmbedInput {
  userId: string;
  texts: string[];
  // Searches someone runs are charged; indexing their own mail is not.
  charge: boolean;
}

export interface EmbedResult {
  model: string;
  dimensions: number;
  vectors: number[][];
}

export type Embedder = (input: EmbedInput) => Promise<EmbedResult>;

interface EmbeddingsResponse {
  data?: { index: number; embedding: number[] }[];
  usage?: { total_tokens?: number };
}

export function createEmbedder({
  apiKey,
  baseUrl = 'https://api.openai.com/v1',
  billing,
  logger,
  timeoutMs = 30_000,
}: {
  apiKey: string | undefined;
  baseUrl?: string;
  billing?: Billing;
  logger: Logger;
  timeoutMs?: number;
}): Embedder {
  return async ({ userId, texts, charge }) => {
    if (!apiKey) {
      throw new ServiceUnavailableError('Semantic search needs an OpenAI key', {
        code: 'EMBEDDINGS_UNAVAILABLE',
      });
    }
    if (charge && billing && !(await billing.allowed(userId))) {
      throw new PaymentRequiredError(
        "You're out of AI credits. Upgrade your plan or wait for your credits to reset.",
        { code: 'OUT_OF_CREDITS' },
      );
    }
    let result: EmbeddingsResponse;
    try {
      result = (await postJson(
        `${baseUrl}/embeddings`,
        { authorization: `Bearer ${apiKey}` },
        { model: EMBEDDING_MODEL.apiName, input: texts, dimensions: EMBEDDING_MODEL.dimensions },
        timeoutMs,
      )) as EmbeddingsResponse;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      logger.warn({ code: err.code, err: err.message }, 'embedding call failed');
      throw new ExternalServiceError('The embedding model could not be reached', {
        code: err.code,
      });
    }
    const vectors = [...(result.data ?? [])]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    if (vectors.length !== texts.length) {
      throw new ServiceUnavailableError('The embedding model skipped some texts', {
        code: 'EMBEDDINGS_INCOMPLETE',
      });
    }
    const tokens = result.usage?.total_tokens ?? 0;
    const costUsd = (tokens / 1_000_000) * EMBEDDING_MODEL.usdPerMillionTokens;
    if (charge && billing && costUsd > 0) {
      await billing
        .charge(userId, {
          callId: randomUUID(),
          purpose: 'search',
          model: EMBEDDING_MODEL.id,
          modelName: EMBEDDING_MODEL.name,
          costUsd,
        })
        .catch((err: unknown) => logger.error({ err }, 'could not report usage'));
    }
    logger.info({ texts: texts.length, tokens, charged: charge }, 'texts embedded');
    return { model: EMBEDDING_MODEL.id, dimensions: EMBEDDING_MODEL.dimensions, vectors };
  };
}
