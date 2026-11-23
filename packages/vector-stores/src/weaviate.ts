import weaviate, { Filters, type WeaviateClient } from 'weaviate-client';
import { cleanName, parsePayload, type Collection, type VectorStore } from './types';

// Class names start with a capital and hold letters, digits and underscores.
const className = (name: string) => {
  const clean = cleanName(name, { allowed: /[^A-Za-z0-9_]/g, max: 200 });
  return clean.charAt(0).toUpperCase() + clean.slice(1);
};

const hostOf = (raw: string) => {
  const url = new URL(raw);
  const secure = url.protocol === 'https:';
  return { host: url.hostname, port: Number(url.port) || (secure ? 443 : 80), secure };
};

async function connect(settings: Record<string, string>): Promise<WeaviateClient> {
  const authCredentials = settings.apiKey ? new weaviate.ApiKey(settings.apiKey) : undefined;
  const http = hostOf(settings.url ?? '');
  // Weaviate Cloud serves gRPC beside REST; a server of your own names its gRPC address.
  if (!settings.grpcUrl && /\.weaviate\.(cloud|network)$/.test(http.host)) {
    return weaviate.connectToWeaviateCloud(settings.url!, {
      ...(authCredentials && { authCredentials }),
    });
  }
  const grpc = settings.grpcUrl
    ? hostOf(settings.grpcUrl)
    : { host: http.host, port: 50051, secure: http.secure };
  return weaviate.connectToCustom({
    httpHost: http.host,
    httpPort: http.port,
    httpSecure: http.secure,
    grpcHost: grpc.host,
    grpcPort: grpc.port,
    grpcSecure: grpc.secure,
    ...(authCredentials && { authCredentials }),
  });
}

// Each email is an object with the user's id (filterable) and its payload as text.
export function weaviateStore(settings: Record<string, string>): VectorStore {
  let client: Promise<WeaviateClient> | null = null;
  const open = () => {
    client ??= connect(settings);
    client.catch(() => (client = null));
    return client;
  };

  return {
    collection(name, dimensions): Collection {
      const cls = className(name);
      const handle = async () => (await open()).collections.use(cls);
      void dimensions;
      return {
        name: cls,
        async ensure() {
          const db = await open();
          if (await db.collections.exists(cls)) return;
          await db.collections.create({
            name: cls,
            properties: [
              { name: 'userId', dataType: 'text', tokenization: 'field' },
              {
                name: 'payload',
                dataType: 'text',
                indexFilterable: false,
                indexSearchable: false,
              },
            ],
            vectorizers: weaviate.configure.vectorizer.selfProvided({
              vectorIndexConfig: weaviate.configure.vectorIndex.hnsw({ distanceMetric: 'cosine' }),
            }),
          });
        },
        async get(_userId, ids, withVectors) {
          if (!ids.length) return [];
          const collection = await handle();
          const { objects } = await collection.query.fetchObjects({
            filters: collection.filter.byId().containsAny(ids),
            includeVector: withVectors,
            limit: ids.length,
          });
          return objects.map((object) => ({
            id: object.uuid,
            vector: (object.vectors.default as number[] | undefined) ?? null,
            payload: parsePayload(object.properties.payload),
          }));
        },
        async upsert(userId, points) {
          if (!points.length) return;
          const collection = await handle();
          // Batches replace objects with the same id.
          const result = await collection.data.insertMany(
            points.map((point) => ({
              id: point.id,
              properties: { userId, payload: JSON.stringify(point.payload) },
              vectors: point.vector,
            })),
          );
          if (result.hasErrors) {
            throw new Error(Object.values(result.errors)[0]?.message ?? 'weaviate write failed');
          }
        },
        async delete(_userId, ids) {
          if (!ids.length) return;
          const collection = await handle();
          await collection.data.deleteMany(collection.filter.byId().containsAny(ids));
        },
        async deleteUser(userId) {
          const collection = await handle();
          await collection.data.deleteMany(collection.filter.byProperty('userId').equal(userId));
        },
        async query(userId, vector, limit) {
          const collection = await handle();
          const { objects } = await collection.query.nearVector(vector, {
            limit,
            filters: Filters.and(collection.filter.byProperty('userId').equal(userId)),
            returnMetadata: ['distance'],
          });
          return objects.map((object) => ({
            id: object.uuid,
            score: 1 - (object.metadata?.distance ?? 1),
            payload: parsePayload(object.properties.payload),
          }));
        },
      };
    },
    async collections() {
      return (await (await open()).collections.listAll()).map((collection) => collection.name);
    },
    async check() {
      const db = await open();
      await db.collections.listAll();
    },
    async close() {
      if (client) await (await client).close();
    },
  };
}
