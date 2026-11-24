import { NotFoundError, ServiceUnavailableError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Ollama } from 'ollama';
import {
  embeddingModels,
  userEmbeddingChoices,
  type EmbeddingModelRow,
  type Provider,
} from '../db/schema';
import type { UserModels } from '../byok/user-models';
import { OWN_PREFIX } from './catalog';
import type { EmbeddingModel } from './embed';

// Hosted rows change only with a migration and Ollama's models only when one is pulled.
const CACHE_TTL_MS = 60_000;

// Any OpenAI-compatible /embeddings endpoint.
const BASE_URL: Partial<Record<Provider, string>> = {
  OPENAI: 'https://api.openai.com/v1',
  GEMINI: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

export interface EmbeddingOption {
  id: string;
  provider: string;
  name: string;
  description: string;
  dimensions: number;
  contextTokens: number | null;
  local: boolean;
  available: boolean;
  usdPerMillionTokens: number;
  // Added by the user with their own key.
  own: boolean;
}

const option = (
  model: EmbeddingModel,
  available: boolean,
  description: string,
  contextTokens: number | null,
): EmbeddingOption => ({
  id: model.id,
  provider: model.id.split('/')[0]!,
  name: model.name,
  description,
  dimensions: model.dimensions,
  contextTokens,
  local: model.local,
  own: false,
  available,
  usdPerMillionTokens: model.usdPerMillionTokens,
});

// Ollama names a model's fields after its architecture, e.g. "bert.embedding_length".
function infoField(info: unknown, suffix: string): number | undefined {
  const entries = info instanceof Map ? [...info.entries()] : Object.entries(info ?? {});
  const value = entries.find(([key]) => String(key).endsWith(suffix))?.[1] as unknown;
  return typeof value === 'number' ? value : undefined;
}

// Which embedding models semantic search can use, and each user's pick. Hosted models come
// from the database (usable once their provider has a working key); local ones are whatever
// embedding models Ollama has pulled.
export function createEmbeddingCatalog({
  db,
  ollama,
  ollamaUrl,
  keys,
  defaultModel,
  logger,
  userModels,
}: {
  db: PostgresJsDatabase;
  ollama: Pick<Ollama, 'list' | 'show'>;
  ollamaUrl: string;
  keys: Partial<Record<Provider, string>>;
  defaultModel: string;
  logger: Logger;
  // Embedding models users added with their own keys, picked as "user:<id>".
  userModels?: Pick<UserModels, 'list' | 'owns' | 'resolve'>;
}) {
  const hostedModel = (row: EmbeddingModelRow): EmbeddingModel => ({
    id: row.id,
    apiName: row.apiName,
    name: row.name,
    dimensions: row.dimensions,
    usdPerMillionTokens: row.price,
    baseUrl: BASE_URL[row.provider] ?? '',
    apiKey: keys[row.provider],
    needsKey: true,
    sendDimensions: row.sendDimensions,
    local: false,
    contextTokens: row.contextTokens,
  });

  async function discoverLocal() {
    const { models } = await ollama.list();
    const found = await Promise.all(
      models.map(async (pulled) => {
        const shown = await ollama.show({ model: pulled.name });
        const dimensions = infoField(shown.model_info, '.embedding_length');
        if (!shown.capabilities?.includes('embedding') || !dimensions) return null;
        const apiName = pulled.name.replace(/:latest$/, '');
        const context = infoField(shown.model_info, '.context_length');
        const model: EmbeddingModel = {
          id: `ollama/${apiName}`,
          apiName,
          name: apiName,
          dimensions,
          usdPerMillionTokens: 0,
          baseUrl: `${ollamaUrl.replace(/\/$/, '')}/v1`,
          apiKey: undefined,
          needsKey: false,
          sendDimensions: false,
          local: true,
          contextTokens: context ?? null,
        };
        const size = pulled.details.parameter_size;
        return {
          model,
          description: size ? `${size} parameters` : '',
          contextTokens: context ?? null,
        };
      }),
    );
    return found.filter((entry) => entry !== null);
  }

  type Cache = {
    at: number;
    hosted: Promise<EmbeddingModelRow[]>;
    local: Promise<Awaited<ReturnType<typeof discoverLocal>>>;
  };
  let cached: Cache | null = null;
  function load() {
    if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
      const fresh: Cache = {
        at: Date.now(),
        hosted: db.select().from(embeddingModels).orderBy(asc(embeddingModels.rank)),
        // Ollama being down hides local models until it is back, rather than failing the list.
        local: discoverLocal().catch((err: unknown) => {
          logger.warn({ err: (err as Error).message }, 'could not list local embedding models');
          if (cached === fresh) cached = null;
          return [];
        }),
      };
      fresh.hosted.catch(() => {
        if (cached === fresh) cached = null;
      });
      cached = fresh;
    }
    return cached;
  }

  const usable = (row: EmbeddingModelRow) => row.enabled && Boolean(keys[row.provider]);

  async function find(id: string): Promise<{ model: EmbeddingModel; available: boolean } | null> {
    const { hosted, local } = load();
    const row = (await hosted).find((candidate) => candidate.id === id);
    if (row) return { model: hostedModel(row), available: usable(row) };
    const pulled = (await local).find((entry) => entry.model.id === id);
    return pulled ? { model: pulled.model, available: true } : null;
  }

  // A user's own embedding model, ready to call with their key.
  async function ownModel(userId: string | undefined, id: string): Promise<EmbeddingModel> {
    try {
      if (!userId || !userModels) throw new Error('no user');
      const { row, sdk } = await userModels.resolve(userId, id.slice(OWN_PREFIX.length));
      if (row.kind !== 'embedding' || !row.dimensions || !sdk.embeddingModel) {
        throw new Error('not an embedding model');
      }
      return {
        id,
        apiName: row.modelId,
        name: row.name,
        dimensions: row.dimensions,
        usdPerMillionTokens: 0,
        baseUrl: '',
        apiKey: undefined,
        needsKey: false,
        sendDimensions: false,
        local: false,
        contextTokens: row.contextTokens ?? null,
        sdk: sdk.embeddingModel(row.modelId),
      };
    } catch (err) {
      logger.warn({ userId, id, err: (err as Error).message }, 'own embedding model unusable');
      throw new ServiceUnavailableError(`The embedding model ${id} is not available`, {
        code: 'EMBEDDINGS_UNAVAILABLE',
      });
    }
  }

  async function choiceOf(userId: string) {
    const [row] = await db
      .select()
      .from(userEmbeddingChoices)
      .where(eq(userEmbeddingChoices.userId, userId));
    return row?.modelId ?? defaultModel;
  }

  return {
    defaultModel,
    choiceOf,

    async list(userId?: string): Promise<EmbeddingOption[]> {
      const { hosted, local } = load();
      const own = userId && userModels ? await userModels.list(userId, 'embedding') : [];
      return [
        ...own.map((model) => ({
          id: `${OWN_PREFIX}${model.id}`,
          provider: model.providerId,
          name: model.name,
          description: `${model.providerName}, your own key`,
          dimensions: model.dimensions ?? 0,
          contextTokens: model.contextTokens,
          local: false,
          available: true,
          usdPerMillionTokens: 0,
          own: true,
        })),
        ...(await local).map(({ model, description, contextTokens }) =>
          option(model, true, description, contextTokens),
        ),
        ...(await hosted).map((row) =>
          option(hostedModel(row), usable(row), row.description, row.contextTokens),
        ),
      ];
    },

    // The model to embed with: the one asked for, else the user's pick, else the default.
    async resolve(userId: string | undefined, id?: string): Promise<EmbeddingModel> {
      const wanted = id ?? (userId ? await choiceOf(userId) : defaultModel);
      if (wanted.startsWith(OWN_PREFIX)) return ownModel(userId, wanted);
      const found = await find(wanted);
      if (!found?.available) {
        throw new ServiceUnavailableError(`The embedding model ${wanted} is not available`, {
          code: 'EMBEDDINGS_UNAVAILABLE',
        });
      }
      return found.model;
    },

    async choose(userId: string, modelId: string) {
      if (modelId.startsWith(OWN_PREFIX)) {
        const owned = await userModels?.owns(userId, modelId.slice(OWN_PREFIX.length), 'embedding');
        if (!owned) throw new NotFoundError(`No embedding model ${modelId}`);
        const model = await ownModel(userId, modelId);
        await db
          .insert(userEmbeddingChoices)
          .values({ userId, modelId })
          .onConflictDoUpdate({ target: userEmbeddingChoices.userId, set: { modelId } });
        return model;
      }
      const found = await find(modelId);
      if (!found) throw new NotFoundError(`No embedding model ${modelId}`);
      if (!found.available) {
        throw new ServiceUnavailableError(`${found.model.name} needs an API key on the server`, {
          code: 'EMBEDDINGS_UNAVAILABLE',
        });
      }
      await db
        .insert(userEmbeddingChoices)
        .values({ userId, modelId })
        .onConflictDoUpdate({ target: userEmbeddingChoices.userId, set: { modelId } });
      return found.model;
    },
  };
}

export type EmbeddingCatalog = ReturnType<typeof createEmbeddingCatalog>;
