import { randomUUID } from 'node:crypto';
import {
  ExternalServiceError,
  PaymentRequiredError,
  ServiceUnavailableError,
} from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { postJson, ProviderError } from '../providers/types';
import type { Billing } from './billing';

export interface EmbeddingModel {
  id: string;
  apiName: string;
  name: string;
  dimensions: number;
  usdPerMillionTokens: number;
  // Any OpenAI-compatible /embeddings endpoint.
  baseUrl: string;
  apiKey: string | undefined;
  needsKey: boolean;
  // Only some models can be shortened on request; others always return their own size.
  sendDimensions: boolean;
}

export interface EmbeddingSettings {
  provider: 'ollama' | 'openai';
  model: string | undefined;
  dimensions: number;
  ollamaUrl: string;
  openAiKey: string | undefined;
}

// Local by default (Ollama, free); OpenAI's text-embedding-3-large when chosen.
export function embeddingModel(settings: EmbeddingSettings): EmbeddingModel {
  if (settings.provider === 'openai') {
    const apiName = settings.model ?? 'text-embedding-3-large';
    return {
      id: `openai/${apiName}`,
      apiName,
      name: `OpenAI ${apiName}`,
      // Shortened from 3072 dimensions: nearly the same quality at a third of Qdrant's memory.
      dimensions: settings.dimensions,
      usdPerMillionTokens: apiName === 'text-embedding-3-large' ? 0.13 : 0.02,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: settings.openAiKey,
      needsKey: true,
      sendDimensions: true,
    };
  }
  const apiName = settings.model ?? 'bge-m3';
  return {
    id: `ollama/${apiName}`,
    apiName,
    name: `${apiName} (local)`,
    dimensions: settings.dimensions,
    usdPerMillionTokens: 0,
    baseUrl: `${settings.ollamaUrl.replace(/\/$/, '')}/v1`,
    apiKey: undefined,
    needsKey: false,
    sendDimensions: false,
  };
}

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

// Which model it uses goes with it, so search can keep one vector index per model.
export type Embedder = ((input: EmbedInput) => Promise<EmbedResult>) & {
  model: { id: string; name: string; dimensions: number };
};

interface EmbeddingsResponse {
  data?: { index: number; embedding: number[] }[];
  usage?: { total_tokens?: number };
}

export function createEmbedder({
  model,
  billing,
  logger,
  timeoutMs = 60_000,
}: {
  model: EmbeddingModel;
  billing?: Billing;
  logger: Logger;
  timeoutMs?: number;
}): Embedder {
  const embed = async ({ userId, texts, charge }: EmbedInput): Promise<EmbedResult> => {
    if (model.needsKey && !model.apiKey) {
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
        `${model.baseUrl}/embeddings`,
        model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {},
        {
          model: model.apiName,
          input: texts,
          ...(model.sendDimensions && { dimensions: model.dimensions }),
        },
        timeoutMs,
      )) as EmbeddingsResponse;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      logger.warn({ code: err.code, err: err.message }, 'embedding call failed');
      // A rejected key is a setup problem, like no key at all: retrying won't help.
      if (err.code === 'AUTH') {
        throw new ServiceUnavailableError('Semantic search needs a working OpenAI key', {
          code: 'EMBEDDINGS_UNAVAILABLE',
        });
      }
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
    // A model of another size would corrupt the vector index, so it is refused outright.
    if (vectors.some((vector) => vector.length !== model.dimensions)) {
      throw new ServiceUnavailableError('The embedding model returned vectors of the wrong size', {
        code: 'EMBEDDINGS_UNAVAILABLE',
      });
    }
    const tokens = result.usage?.total_tokens ?? 0;
    const costUsd = (tokens / 1_000_000) * model.usdPerMillionTokens;
    if (charge && billing && costUsd > 0) {
      await billing
        .charge(userId, {
          callId: randomUUID(),
          purpose: 'search',
          model: model.id,
          modelName: model.name,
          costUsd,
        })
        .catch((err: unknown) => logger.error({ err }, 'could not report usage'));
    }
    logger.info({ texts: texts.length, tokens, charged: charge }, 'texts embedded');
    return { model: model.id, dimensions: model.dimensions, vectors };
  };
  return Object.assign(embed, {
    model: { id: model.id, name: model.name, dimensions: model.dimensions },
  });
}
