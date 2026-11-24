import { Client as ElasticClient } from '@elastic/elasticsearch';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { cleanName, fromHalfCosine, type Collection, type VectorStore } from './types';

const indexName = (name: string) =>
  cleanName(name.toLowerCase(), { allowed: /[^a-z0-9_-]/g, max: 255 });

interface Source {
  userId: string;
  payload: Record<string, unknown>;
  vector?: number[];
}

// What Elasticsearch and OpenSearch differ in: the vector mapping and the kNN query.
interface Engine {
  createIndex(index: string, dimensions: number): Promise<void>;
  exists(index: string): Promise<boolean>;
  mget(index: string, ids: string[]): Promise<{ _id: string; found?: boolean; _source?: Source }[]>;
  bulk(operations: object[]): Promise<void>;
  deleteByUser(index: string, userId: string): Promise<void>;
  knn(
    index: string,
    userId: string,
    vector: number[],
    k: number,
  ): Promise<{ _id: string; _score: number | null; _source?: Partial<Source> }[]>;
  indices(): Promise<string[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

function engineStore(engine: Engine): VectorStore {
  return {
    collection(name, dimensions): Collection {
      const index = indexName(name);
      return {
        name: index,
        async ensure() {
          if (!(await engine.exists(index))) await engine.createIndex(index, dimensions);
        },
        async get(userId, ids, withVectors) {
          if (!ids.length) return [];
          const docs = await engine.mget(index, ids);
          return docs
            .filter((doc) => doc.found && doc._source?.userId === userId)
            .map((doc) => ({
              id: doc._id,
              vector: withVectors ? (doc._source?.vector ?? null) : null,
              payload: doc._source!.payload,
            }));
        },
        async upsert(userId, points) {
          if (!points.length) return;
          await engine.bulk(
            points.flatMap((point) => [
              { index: { _index: index, _id: point.id } },
              { userId, payload: point.payload, vector: point.vector },
            ]),
          );
        },
        async delete(_userId, ids) {
          if (ids.length)
            await engine.bulk(ids.map((id) => ({ delete: { _index: index, _id: id } })));
        },
        deleteUser: (userId) => engine.deleteByUser(index, userId),
        async query(userId, vector, limit) {
          const hits = await engine.knn(index, userId, vector, limit);
          return hits.map((hit) => ({
            id: hit._id,
            score: fromHalfCosine(hit._score ?? 0),
            payload: hit._source?.payload ?? {},
          }));
        },
      };
    },
    collections: () => engine.indices(),
    check: () => engine.ping(),
    close: () => engine.close(),
  };
}

const mappings = (vector: object) => ({
  properties: {
    userId: { type: 'keyword' },
    payload: { type: 'object', enabled: false },
    vector,
  },
});

export function elasticsearchStore(settings: Record<string, string>): VectorStore {
  const client = new ElasticClient({
    node: settings.url ?? '',
    ...(settings.apiKey && { auth: { apiKey: settings.apiKey } }),
    requestTimeout: 30_000,
  });
  return engineStore({
    async createIndex(index, dimensions) {
      await client.indices.create(
        {
          index,
          // Vectors are kept in _source, so rewriting a payload can carry its vector over.
          settings: { 'index.mapping.exclude_source_vectors': false },
          mappings: mappings({
            type: 'dense_vector',
            dims: dimensions,
            index: true,
            similarity: 'cosine',
          }) as never,
        },
        { ignore: [400] },
      );
    },
    exists: (index) => client.indices.exists({ index }),
    async mget(index, ids) {
      return (await client.mget<Source>({ index, ids })).docs;
    },
    async bulk(operations) {
      const result = await client.bulk({ operations, refresh: 'wait_for' });
      if (result.errors)
        throw new Error(JSON.stringify(result.items.find((item) => Object.values(item)[0]?.error)));
    },
    async deleteByUser(index, userId) {
      await client.deleteByQuery({
        index,
        query: { term: { userId } },
        refresh: true,
        conflicts: 'proceed',
      });
    },
    async knn(index, userId, vector, k) {
      const result = await client.search<Partial<Source>>({
        index,
        size: k,
        knn: {
          field: 'vector',
          query_vector: vector,
          k,
          num_candidates: Math.min(k * 2, 10_000),
          filter: { term: { userId } },
        },
        _source: ['payload'],
      });
      return result.hits.hits as {
        _id: string;
        _score: number | null;
        _source?: Partial<Source>;
      }[];
    },
    async indices() {
      return (await client.cat.indices({ format: 'json', h: 'index' })).map((row) =>
        String(row.index),
      );
    },
    async ping() {
      await client.info();
    },
    close: () => client.close(),
  });
}

export function openSearchStore(settings: Record<string, string>): VectorStore {
  const client = new OpenSearchClient({
    node: settings.url ?? '',
    ...(settings.username && {
      auth: { username: settings.username, password: settings.password ?? '' },
    }),
    requestTimeout: 30_000,
  });
  return engineStore({
    async createIndex(index, dimensions) {
      await client.indices.create(
        {
          index,
          body: {
            settings: { index: { knn: true } },
            mappings: mappings({
              type: 'knn_vector',
              dimension: dimensions,
              method: { name: 'hnsw', space_type: 'cosinesimil', engine: 'lucene' },
            }),
          } as never,
        },
        { ignore: [400] },
      );
    },
    async exists(index) {
      return (await client.indices.exists({ index })).body;
    },
    async mget(index, ids) {
      return (await client.mget({ index, body: { ids } })).body.docs as never;
    },
    async bulk(operations) {
      const { body } = await client.bulk({ body: operations as never, refresh: 'wait_for' });
      if (body.errors)
        throw new Error(JSON.stringify(body.items.find((item) => Object.values(item)[0]?.error)));
    },
    async deleteByUser(index, userId) {
      await client.deleteByQuery({
        index,
        body: { query: { term: { userId } } },
        refresh: true,
        conflicts: 'proceed',
      });
    },
    async knn(index, userId, vector, k) {
      const { body } = await client.search({
        index,
        body: {
          size: k,
          query: { knn: { vector: { vector, k, filter: { term: { userId } } } } },
          _source: ['payload'],
        },
      });
      return body.hits.hits as never;
    },
    async indices() {
      const { body } = await client.cat.indices({ format: 'json', h: ['index'] });
      return (body as { index: string }[]).map((row) => row.index);
    },
    async ping() {
      await client.info();
    },
    close: () => client.close(),
  });
}
