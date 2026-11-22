import { randomUUID } from 'node:crypto';
import {
  ExternalServiceError,
  PaymentRequiredError,
  ServiceUnavailableError,
} from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { postJson, ProviderError } from '../providers/types';
import type { Billing } from './billing';
import type { EmbeddingCatalog } from './embedding-catalog';

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
  // Runs beside OneBox (Ollama) rather than at a provider.
  local: boolean;
}

export interface EmbedInput {
  userId: string;
  texts: string[];
  // Searches someone runs are charged; indexing their own mail is not.
  charge: boolean;
  // Rebuilding with a new model names it; otherwise the user's own pick is used.
  model?: string;
}

export interface EmbedResult {
  model: string;
  dimensions: number;
  vectors: number[][];
}

export interface EmbedModelSummary {
  id: string;
  name: string;
  dimensions: number;
  local: boolean;
}

// Which model it uses goes with it, so search can keep one vector index per model.
export type Embedder = ((input: EmbedInput) => Promise<EmbedResult>) & {
  model: EmbedModelSummary;
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
      throw new ServiceUnavailableError(`${model.name} needs an API key on the server`, {
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
        throw new ServiceUnavailableError(`${model.name} needs a working API key`, {
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
    model: { id: model.id, name: model.name, dimensions: model.dimensions, local: model.local },
  });
}

// Embeds with the model a request names, else the user's pick, else the server default.
export function createEmbeddings({
  catalog,
  billing,
  logger,
}: {
  catalog: Pick<EmbeddingCatalog, 'resolve'>;
  billing?: Billing;
  logger: Logger;
}) {
  const embedders = new Map<string, Embedder>();
  const embedderFor = (model: EmbeddingModel) => {
    // A re-pulled local model can change size, so the size is part of the key.
    const key = `${model.id}@${model.dimensions}`;
    let embedder = embedders.get(key);
    if (!embedder) {
      embedder = createEmbedder({ model, billing, logger });
      embedders.set(key, embedder);
    }
    return embedder;
  };
  const embed = async (input: EmbedInput) =>
    embedderFor(await catalog.resolve(input.userId, input.model))(input);
  return Object.assign(embed, {
    modelFor: async (userId?: string): Promise<EmbedModelSummary> =>
      embedderFor(await catalog.resolve(userId)).model,
  });
}

export type Embeddings = ReturnType<typeof createEmbeddings>;
