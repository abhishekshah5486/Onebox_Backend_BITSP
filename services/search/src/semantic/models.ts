import { createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { Redis } from 'ioredis';
import { collectionFor, type EmbedModel } from '../clients/embed-client';
import type {
  ConfiguredVectorStore,
  VectorStoreConnection,
  VectorStoreSetup,
} from '@onebox/contracts';
import { openVectorStore } from '@onebox/vector-stores';
import { ONEBOX_STORE_ID } from '@onebox/contracts';
import { createStoreIndex } from './store-index';
import { createVectorIndex, type VectorIndex } from './vector-index';

// A user's pick is re-read this often; a switch also refreshes it straight away.
const CHOSEN_TTL_S = 30;
const STORE_TTL_MS = 30_000;
const ONEBOX = ONEBOX_STORE_ID;

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

// A user's own store. Its key changes with its settings, so new keys or a new address count
// as a new place, which is caught up again.
function ownStore(store: Exclude<ConfiguredVectorStore, { provider: 'ONEBOX' }>): Store {
  const key = `own:${store.id}:${createHash('sha256')
    .update(JSON.stringify([store.provider, Object.entries(store.settings).sort()]))
    .digest('hex')
    .slice(0, 16)}`;
  if (store.provider === 'QDRANT') {
    const { url, apiKey } = store.settings;
    return qdrantStore(
      key,
      new QdrantClient({ url: url ?? '', ...(apiKey && { apiKey }), checkCompatibility: false }),
    );
  }
  const opened = openVectorStore(store.provider, store.settings);
  return {
    id: key,
    open: (collection, dimensions) =>
      createStoreIndex(opened.collection(collection, dimensions), () => opened.check()),
    async collections() {
      return (await opened.collections()).filter((name) => OUR_COLLECTION.test(name));
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

// One of a user's stores, as search uses it: `id` is the store's id in settings, and
// `store.id` its key here (which changes with its settings).
export interface UserStore {
  id: string;
  store: Store;
  paused: boolean;
}
export interface UserSetup {
  search: UserStore;
  stores: UserStore[];
}

// Which model each user's mail is embedded and searched with, and in which stores. Searches use
// the "active" model, in the user's search store, until a rebuild with a new pick has finished;
// new mail goes to both models meanwhile, in every store that isn't paused. A store that was
// paused, or is new, is caught up with what it missed.
export function createSemanticModels({
  qdrant,
  redis,
  fetchModel,
  defaultModel,
  fetchSetup = async () => ({
    searchStoreId: ONEBOX,
    stores: [{ id: ONEBOX, provider: 'ONEBOX', paused: false }],
  }),
  requestRebuild = async () => {},
}: {
  qdrant: QdrantClient;
  redis: ModelStore;
  fetchModel: (userId: string) => Promise<EmbedModel>;
  // What everyone used before picking: the server default.
  defaultModel: EmbedModel;
  fetchSetup?: (userId: string) => Promise<VectorStoreSetup>;
  // Queues embedding the user's mail again: with a new model everywhere, or into one store.
  requestRebuild?: (
    userId: string,
    modelId: string,
    reason: string,
    storeId?: string,
  ) => Promise<void>;
}) {
  const chosenKey = (userId: string) => `search:semantic:chosen:${userId}`;
  const activeKey = (userId: string) => `search:semantic:active:${userId}`;
  const rebuildKey = (userId: string) => `search:semantic:rebuild:${userId}`;
  // The model a store holds every one of the user's emails with; "" while it's behind.
  const builtKey = (userId: string, storeKey: string) =>
    `search:semantic:built:${userId}:${storeKey}`;
  const catchupKey = (userId: string, storeKey: string) =>
    `search:semantic:catchup:${userId}:${storeKey}`;

  const onebox = qdrantStore(ONEBOX, qdrant);
  const owned = new Map<string, Store>();
  const setups = new Map<string, { at: number; setup: Promise<UserSetup> }>();

  // Keys never go to Redis; the setup is asked for again every half minute.
  async function connect(userId: string): Promise<UserSetup> {
    const setup = await fetchSetup(userId);
    const stores = setup.stores.map((configured) => {
      if (configured.provider === 'ONEBOX') {
        return { id: ONEBOX, store: onebox, paused: configured.paused };
      }
      const made = ownStore(configured);
      // One client per store, however many lookups share it.
      if (!owned.has(made.id)) owned.set(made.id, made);
      return { id: configured.id, store: owned.get(made.id)!, paused: configured.paused };
    });
    const search = stores.find((entry) => entry.id === setup.searchStoreId) ??
      stores.find((entry) => entry.id === ONEBOX) ?? { id: ONEBOX, store: onebox, paused: false };
    // The search store always takes new mail.
    search.paused = false;
    return { search, stores };
  }

  function setupOf(userId: string, { fresh = false } = {}) {
    const cached = setups.get(userId);
    if (!fresh && cached && Date.now() - cached.at < STORE_TTL_MS) return cached.setup;
    const setup = connect(userId);
    setups.set(userId, { at: Date.now(), setup });
    setup.catch(() => setups.delete(userId));
    return setup;
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

  // The model a store is complete with. OneBox's counts as complete with the model in use
  // until it's paused, as it was the only store before there were others.
  async function builtWith(userId: string, entry: UserStore) {
    const saved = await redis.get(builtKey(userId, entry.store.id));
    if (saved !== null) return saved;
    return entry.store === onebox ? (await active(userId)).id : '';
  }

  // Paused stores fall behind; stores behind the model in use, and not paused, are caught up.
  async function sync(userId: string, setup: UserSetup) {
    const model = await active(userId);
    for (const entry of setup.stores) {
      if (entry.paused) {
        await redis.set(builtKey(userId, entry.store.id), '');
        // A backup it was running stops, so resuming must start another.
        await redis.del(catchupKey(userId, entry.store.id));
        continue;
      }
      if ((await builtWith(userId, entry)) === model.id) continue;
      const key = catchupKey(userId, entry.store.id);
      if ((await redis.hgetall(key)).modelId === model.id) continue;
      // Marked as it's queued, so other emails noticing meanwhile don't queue it again.
      await redis.hset(key, { modelId: model.id, done: 0, total: 0 });
      try {
        await requestRebuild(userId, model.id, `catchup:${entry.store.id}:${Date.now()}`, entry.id);
      } catch (err) {
        await redis.del(key);
        throw err;
      }
    }
  }

  const live = (setup: UserSetup) => setup.stores.filter((entry) => !entry.paused);

  return {
    indexFor,
    chosen,
    active,
    setupOf,
    forgetSetup: (userId: string) => void setups.delete(userId),

    // Settings said the user's stores changed: look again, and catch up what needs it.
    async refresh(userId: string) {
      setups.delete(userId);
      await sync(userId, await setupOf(userId, { fresh: true }));
    },

    // Where a user's new mail is embedded: with what they search with, and what they picked,
    // in every store that isn't paused.
    async targets(userId: string) {
      const [now, next, setup] = await Promise.all([
        active(userId),
        chosen(userId),
        setupOf(userId),
      ]);
      await sync(userId, setup);
      const models = now.id === next.id && now.dimensions === next.dimensions ? [now] : [now, next];
      return Promise.all(
        live(setup).flatMap((entry) =>
          models.map(async (model) => ({ model, index: await indexFor(model, entry.store) })),
        ),
      );
    },

    // What a search runs against: the model the mail is embedded with, in the search store.
    async searchTarget(userId: string) {
      const [model, setup] = await Promise.all([active(userId), setupOf(userId)]);
      return { model, index: await indexFor(model, setup.search.store) };
    },

    // Every model's index in every store, paused ones too, for removals: a deleted email
    // shouldn't linger anywhere.
    async allIndexes(userId?: string) {
      const stores = userId ? (await setupOf(userId)).stores.map((entry) => entry.store) : [onebox];
      const unique = [...new Map(stores.map((store) => [store.id, store])).values()];
      return (await Promise.all(unique.map(collectionsIn))).flat();
    },

    // How each store is doing, for the settings page.
    async storesOf(userId: string) {
      const setup = await setupOf(userId);
      const model = await active(userId);
      return Promise.all(
        setup.stores.map(async (entry) => {
          const catching = await redis.hgetall(catchupKey(userId, entry.store.id));
          return {
            id: entry.id,
            paused: entry.paused,
            search: entry === setup.search,
            upToDate: (await builtWith(userId, entry)) === model.id,
            catchup: catching.modelId
              ? { done: Number(catching.done), total: Number(catching.total) }
              : null,
          };
        }),
      );
    },

    async startRebuild(userId: string, modelId: string, total: number) {
      await redis.del(rebuildKey(userId));
      await redis.hset(rebuildKey(userId), {
        modelId,
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

    // The rebuild is done: searches switch over, the stores it filled are complete with the new
    // model, and the old model's vectors leave them.
    async finishRebuild(userId: string, model: EmbedModel, stores: UserStore[]) {
      const before = await active(userId);
      await redis.set(activeKey(userId), JSON.stringify(model));
      await redis.del(rebuildKey(userId));
      for (const entry of stores) {
        await redis.set(builtKey(userId, entry.store.id), model.id);
        if (collectionFor(before) !== collectionFor(model)) {
          await (await indexFor(before, entry.store)).removeUser(userId);
        }
      }
    },

    async startCatchup(userId: string, entry: UserStore, modelId: string, total: number) {
      await redis.del(catchupKey(userId, entry.store.id));
      await redis.hset(catchupKey(userId, entry.store.id), { modelId, done: 0, total });
    },
    catchupProgress: (userId: string, entry: UserStore, done: number) =>
      redis.hincrby(catchupKey(userId, entry.store.id), 'done', done),

    // A store is caught up: it's complete with the model in use, and keeps no other model's
    // vectors, except a model a rebuild is filling.
    // A backup stopped short (paused, removed, failed): the next look starts a fresh one. One
    // for another model meanwhile is left alone.
    async abandonCatchup(userId: string, entry: UserStore, modelId: string) {
      const key = catchupKey(userId, entry.store.id);
      if ((await redis.hgetall(key)).modelId === modelId) await redis.del(key);
    },

    async finishCatchup(userId: string, entry: UserStore, model: EmbedModel) {
      await redis.set(builtKey(userId, entry.store.id), model.id);
      await redis.del(catchupKey(userId, entry.store.id));
      // Compared as the store names them, e.g. Pinecone's "mail-…".
      const named = (kept: EmbedModel) => entry.store.open(collectionFor(kept), 0).collection;
      const keep = new Set([named(model)]);
      const rebuilding = await redis.hgetall(rebuildKey(userId));
      if (rebuilding.modelId) keep.add(named(await chosen(userId)));
      for (const index of await collectionsIn(entry.store)) {
        if (!keep.has(index.collection)) await index.removeUser(userId);
      }
    },
  };
}

export type SemanticModels = ReturnType<typeof createSemanticModels>;
