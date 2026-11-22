import { createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { Redis } from 'ioredis';
import { collectionFor, type EmbedModel } from '../clients/embed-client';
import type { VectorStoreConnection } from '@onebox/contracts';
import { openVectorStore } from '@onebox/vector-stores';
import { createStoreIndex } from './store-index';
import { createVectorIndex, type VectorIndex } from './vector-index';

// A user's pick is re-read this often; a switch also refreshes it straight away.
const CHOSEN_TTL_S = 30;
const STORE_TTL_MS = 30_000;
const ONEBOX = 'onebox';

// Where a user's vectors live: OneBox's Qdrant, or a vector database of their own.
export type StoreConnection = VectorStoreConnection;

// What search needs from an index, whichever database holds it.
export interface SemanticIndex {
  collection: string;
  ensure(): Promise<void>;
  upsert: VectorIndex['upsert'];
  upsertMany: VectorIndex['upsertMany'];
  removeUser(userId: string): Promise<unknown>;
  removeCopy(key: string, messageId: string, version: number, userId?: string): Promise<boolean>;
  search: VectorIndex['search'];
  ping(): Promise<unknown>;
}

export interface Store {
  id: string;
  open(collection: string, dimensions: number): SemanticIndex;
  // OneBox's collections in it.
  collections(): Promise<string[]>;
}
// Every collection is named mail_<model>_<size>; stores that don't allow underscores or
// lowercase turn that into e.g. mail-<model>-<size> or Mail_<model>_<size>.
const OUR_COLLECTION = /^mail[_-]/i;

function qdrantStore(id: string, client: QdrantClient): Store {
  return {
    id,
    open: (collection, dimensions) => createVectorIndex(client, collection, dimensions),
    async collections() {
      return (await client.getCollections()).collections
        .map(({ name }) => name)
        .filter((name) => OUR_COLLECTION.test(name));
    },
  };
}

// A user's own store. Its id changes with its settings, so new keys or a new address count
// as a move and the vectors are built there again.
function ownStore(connection: Exclude<VectorStoreConnection, { provider: 'ONEBOX' }>): Store {
  const id = `own:${createHash('sha256')
    .update(JSON.stringify([connection.provider, Object.entries(connection.settings).sort()]))
    .digest('hex')
    .slice(0, 16)}`;
  if (connection.provider === 'QDRANT') {
    const { url, apiKey } = connection.settings;
    return qdrantStore(
      id,
      new QdrantClient({ url: url ?? '', ...(apiKey && { apiKey }), checkCompatibility: false }),
    );
  }
  const store = openVectorStore(connection.provider, connection.settings);
  return {
    id,
    open: (collection, dimensions) =>
      createStoreIndex(store.collection(collection, dimensions), () => store.check()),
    async collections() {
      return (await store.collections()).filter((name) => OUR_COLLECTION.test(name));
    },
  };
}

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

  const onebox = qdrantStore(ONEBOX, qdrant);
  const owned = new Map<string, Store>();
  const stores = new Map<string, { at: number; store: Promise<Store> }>();

  // Keys never go to Redis; the store is asked for again every half minute.
  async function connect(userId: string): Promise<Store> {
    const connection = await fetchStore(userId);
    if (connection.provider === 'ONEBOX') return onebox;
    const store = ownStore(connection);
    // One client per store, however many users or lookups share it.
    if (!owned.has(store.id)) owned.set(store.id, store);
    return owned.get(store.id)!;
  }

  function storeOf(userId: string, { fresh = false } = {}) {
    const cached = stores.get(userId);
    if (!fresh && cached && Date.now() - cached.at < STORE_TTL_MS) return cached.store;
    const store = connect(userId);
    stores.set(userId, { at: Date.now(), store });
    store.catch(() => stores.delete(userId));
    return store;
  }

  const indexes = new Map<string, Promise<SemanticIndex>>();
  function indexFor(model: EmbedModel, store: Store = onebox) {
    const collection = collectionFor(model);
    const key = `${store.id}/${collection}`;
    let index = indexes.get(key);
    if (!index) {
      const created = store.open(collection, model.dimensions);
      index = created.ensure().then(() => created);
      // A failed setup is tried again next time.
      index.catch(() => indexes.delete(key));
      indexes.set(key, index);
    }
    return index;
  }

  const collectionsIn = async (store: Store) =>
    (await store.collections()).map((name) => store.open(name, 0));

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
