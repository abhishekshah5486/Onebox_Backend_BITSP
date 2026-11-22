import { createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { Redis } from 'ioredis';
import { collectionFor, type EmbedModel } from '../clients/embed-client';
import { createVectorIndex, type VectorIndex } from './vector-index';

// A user's pick is re-read this often; a switch also refreshes it straight away.
const CHOSEN_TTL_S = 30;
const STORE_TTL_MS = 30_000;
const ONEBOX = 'onebox';

// Where a user's vectors live: OneBox's Qdrant, or their own.
export type StoreConnection =
  { provider: 'ONEBOX' } | { provider: 'QDRANT'; url: string; apiKey: string | null };

export interface Store {
  id: string;
  client: QdrantClient;
}
// Every collection is named mail_<model>_<size>.
const COLLECTION_PREFIX = 'mail_';

export type ModelStore = Pick<Redis, 'get' | 'set' | 'del' | 'hset' | 'hgetall' | 'hincrby'>;

export interface RebuildState {
  modelId: string;
  done: number;
  total: number;
  startedAt: string;
}

// Which model each user's mail is embedded and searched with. Searches use the "active" model
// until a rebuild with the user's new pick has finished; new mail goes to both meanwhile.
export function createSemanticModels({
  qdrant,
  redis,
  fetchModel,
  defaultModel,
  fetchStore = async () => ({ provider: 'ONEBOX' }),
  requestRebuild = async () => {},
}: {
  qdrant: QdrantClient;
  redis: ModelStore;
  fetchModel: (userId: string) => Promise<EmbedModel>;
  // What everyone used before picking: the server default.
  defaultModel: EmbedModel;
  fetchStore?: (userId: string) => Promise<StoreConnection>;
  // Queues embedding the user's mail again, e.g. into a store they just moved to.
  requestRebuild?: (userId: string, modelId: string, reason: string) => Promise<void>;
}) {
  const chosenKey = (userId: string) => `search:semantic:chosen:${userId}`;
  const activeKey = (userId: string) => `search:semantic:active:${userId}`;
  const rebuildKey = (userId: string) => `search:semantic:rebuild:${userId}`;
  // Which store the user's searchable vectors were last built in.
  const builtKey = (userId: string) => `search:semantic:store:${userId}`;

  const onebox: Store = { id: ONEBOX, client: qdrant };
  const clients = new Map<string, QdrantClient>();
  const stores = new Map<string, { at: number; store: Promise<Store> }>();

  // Keys never go to Redis; the store is asked for again every half minute.
  async function connect(userId: string): Promise<Store> {
    const connection = await fetchStore(userId);
    if (connection.provider === 'ONEBOX') return onebox;
    const id = `own:${createHash('sha256')
      .update(`${connection.url}\n${connection.apiKey ?? ''}`)
      .digest('hex')
      .slice(0, 16)}`;
    let client = clients.get(id);
    if (!client) {
      client = new QdrantClient({
        url: connection.url,
        ...(connection.apiKey && { apiKey: connection.apiKey }),
        checkCompatibility: false,
      });
      clients.set(id, client);
    }
    return { id, client };
  }

  function storeOf(userId: string, { fresh = false } = {}) {
    const cached = stores.get(userId);
    if (!fresh && cached && Date.now() - cached.at < STORE_TTL_MS) return cached.store;
    const store = connect(userId);
    stores.set(userId, { at: Date.now(), store });
    store.catch(() => stores.delete(userId));
    return store;
  }

  const indexes = new Map<string, Promise<VectorIndex>>();
  function indexFor(model: EmbedModel, store: Store = onebox) {
    const collection = collectionFor(model);
    const key = `${store.id}/${collection}`;
    let index = indexes.get(key);
    if (!index) {
      const created = createVectorIndex(store.client, collection, model.dimensions);
      index = created.ensure().then(() => created);
      // A failed setup is tried again next time.
      index.catch(() => indexes.delete(key));
      indexes.set(key, index);
    }
    return index;
  }

  const collectionsIn = async (store: Store) =>
    (await store.client.getCollections()).collections
      .filter(({ name }) => name.startsWith(COLLECTION_PREFIX))
      .map(({ name }) => createVectorIndex(store.client, name, 0));

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

  // A store the vectors haven't been built in yet (e.g. the user just moved) gets a rebuild,
  // in case settings couldn't tell search itself.
  async function noticeMove(userId: string, store: Store) {
    const built = (await redis.get(builtKey(userId))) ?? ONEBOX;
    if (built === store.id) return;
    const rebuilding = await redis.hgetall(rebuildKey(userId));
    if (rebuilding.storeId === store.id) return;
    await requestRebuild(userId, (await chosen(userId)).id, `store:${store.id}`);
  }

  return {
    indexFor,
    chosen,
    active,
    storeOf,
    forgetStore: (userId: string) => void stores.delete(userId),

    // Where a user's new mail is embedded: what they search with, and what they picked.
    async targets(userId: string) {
      const [now, next, store] = await Promise.all([
        active(userId),
        chosen(userId),
        storeOf(userId),
      ]);
      await noticeMove(userId, store);
      const models = now.id === next.id && now.dimensions === next.dimensions ? [now] : [now, next];
      return Promise.all(
        models.map(async (model) => ({ model, index: await indexFor(model, store) })),
      );
    },

    // What a search runs against: the model the mail is embedded with, in the user's store.
    async searchTarget(userId: string) {
      const [model, store] = await Promise.all([active(userId), storeOf(userId)]);
      return { model, index: await indexFor(model, store) };
    },

    // Every model's index, for removals, which don't say which model the email was in.
    async allIndexes(userId?: string) {
      const store = userId ? await storeOf(userId) : onebox;
      return [
        ...(await collectionsIn(onebox)),
        ...(store.id === ONEBOX ? [] : await collectionsIn(store)),
      ];
    },

    async startRebuild(userId: string, modelId: string, total: number, storeId = ONEBOX) {
      await redis.del(rebuildKey(userId));
      await redis.hset(rebuildKey(userId), {
        modelId,
        storeId,
        done: 0,
        total,
        startedAt: new Date().toISOString(),
      });
    },
    progress: (userId: string, done: number) => redis.hincrby(rebuildKey(userId), 'done', done),
    async rebuildOf(userId: string): Promise<RebuildState | null> {
      const state = await redis.hgetall(rebuildKey(userId));
      if (!state.modelId) return null;
      return {
        modelId: state.modelId,
        done: Number(state.done),
        total: Number(state.total),
        startedAt: state.startedAt ?? new Date().toISOString(),
      };
    },

    // The rebuild is done: searches switch over and the old model's vectors go. Moving to the
    // user's own store takes their vectors off OneBox's; their own store is theirs to keep.
    async finishRebuild(userId: string, model: EmbedModel, store: Store = onebox) {
      const before = await active(userId);
      const builtIn = (await redis.get(builtKey(userId))) ?? ONEBOX;
      await redis.set(activeKey(userId), JSON.stringify(model));
      await redis.set(builtKey(userId), store.id);
      await redis.del(rebuildKey(userId));
      if (builtIn === store.id && collectionFor(before) !== collectionFor(model)) {
        await (await indexFor(before, store)).removeUser(userId);
      }
      if (builtIn === ONEBOX && store.id !== ONEBOX) {
        await Promise.all((await collectionsIn(onebox)).map((index) => index.removeUser(userId)));
      }
    },
  };
}

export type SemanticModels = ReturnType<typeof createSemanticModels>;
