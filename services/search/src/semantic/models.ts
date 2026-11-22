import type { QdrantClient } from '@qdrant/js-client-rest';
import type { Redis } from 'ioredis';
import { collectionFor, type EmbedModel } from '../clients/embed-client';
import { createVectorIndex, type VectorIndex } from './vector-index';

// A user's pick is re-read this often; a switch also refreshes it straight away.
const CHOSEN_TTL_S = 30;
// Every collection is named mail_<model>_<size>.
const COLLECTION_PREFIX = 'mail_';

export type ModelStore = Pick<Redis, 'get' | 'set' | 'del' | 'hset' | 'hgetall' | 'hincrby'>;

export interface RebuildState {
  modelId: string;
  done: number;
  total: number;
}

// Which model each user's mail is embedded and searched with. Searches use the "active" model
// until a rebuild with the user's new pick has finished; new mail goes to both meanwhile.
export function createSemanticModels({
  qdrant,
  redis,
  fetchModel,
  defaultModel,
}: {
  qdrant: QdrantClient;
  redis: ModelStore;
  fetchModel: (userId: string) => Promise<EmbedModel>;
  // What everyone used before picking: the server default.
  defaultModel: EmbedModel;
}) {
  const chosenKey = (userId: string) => `search:semantic:chosen:${userId}`;
  const activeKey = (userId: string) => `search:semantic:active:${userId}`;
  const rebuildKey = (userId: string) => `search:semantic:rebuild:${userId}`;

  const indexes = new Map<string, Promise<VectorIndex>>();
  function indexFor(model: EmbedModel) {
    const collection = collectionFor(model);
    let index = indexes.get(collection);
    if (!index) {
      const created = createVectorIndex(qdrant, collection, model.dimensions);
      index = created.ensure().then(() => created);
      // A failed setup is tried again next time.
      index.catch(() => indexes.delete(collection));
      indexes.set(collection, index);
    }
    return index;
  }

  async function chosen(userId: string, { fresh = false } = {}) {
    const cached = fresh ? null : await redis.get(chosenKey(userId));
    if (cached) return JSON.parse(cached) as EmbedModel;
    const model = await fetchModel(userId);
    await redis.set(chosenKey(userId), JSON.stringify(model), 'EX', CHOSEN_TTL_S);
    return model;
  }

  async function active(userId: string) {
    const saved = await redis.get(activeKey(userId));
    return saved ? (JSON.parse(saved) as EmbedModel) : defaultModel;
  }

  return {
    indexFor,
    chosen,
    active,

    // Where a user's new mail is embedded: what they search with, and what they picked.
    async targets(userId: string) {
      const [now, next] = await Promise.all([active(userId), chosen(userId)]);
      return now.id === next.id && now.dimensions === next.dimensions ? [now] : [now, next];
    },

    // Every model's index, for removals, which don't say whose email it was.
    async allIndexes() {
      const { collections } = await qdrant.getCollections();
      return collections
        .filter(({ name }) => name.startsWith(COLLECTION_PREFIX))
        .map(({ name }) => createVectorIndex(qdrant, name, 0));
    },

    async startRebuild(userId: string, modelId: string, total: number) {
      await redis.del(rebuildKey(userId));
      await redis.hset(rebuildKey(userId), { modelId, done: 0, total });
    },
    progress: (userId: string, done: number) => redis.hincrby(rebuildKey(userId), 'done', done),
    async rebuildOf(userId: string): Promise<RebuildState | null> {
      const state = await redis.hgetall(rebuildKey(userId));
      if (!state.modelId) return null;
      return { modelId: state.modelId, done: Number(state.done), total: Number(state.total) };
    },

    // The rebuild is done: searches switch over and the old model's vectors go.
    async finishRebuild(userId: string, model: EmbedModel) {
      const before = await active(userId);
      await redis.set(activeKey(userId), JSON.stringify(model));
      await redis.del(rebuildKey(userId));
      if (collectionFor(before) !== collectionFor(model)) {
        await (await indexFor(before)).removeUser(userId);
      }
    },
  };
}

export type SemanticModels = ReturnType<typeof createSemanticModels>;
