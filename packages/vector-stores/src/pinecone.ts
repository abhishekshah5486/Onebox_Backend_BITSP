import { Pinecone } from '@pinecone-database/pinecone';
import { cleanName, parsePayload, type Collection, type VectorStore } from './types';

// Index names are lowercase letters, digits and dashes, up to 45 long.
const indexName = (name: string) =>
  cleanName(name.toLowerCase(), { allowed: /[^a-z0-9-]/g, replace: '-', max: 45 });

// One namespace per user, so a user's vectors are queried and cleared on their own.
export function pineconeStore(settings: Record<string, string>): VectorStore {
  const client = new Pinecone({
    apiKey: settings.apiKey ?? '',
    ...(settings.controllerHost && { controllerHostUrl: settings.controllerHost }),
  });
  const cloud = (settings.cloud || 'aws') as 'aws' | 'gcp' | 'azure';
  const region = settings.region || 'us-east-1';
  // A Pinecone served over plain http (its local emulator) reports index hosts without a
  // scheme; they're only trusted on the same server as the API host.
  const controller = settings.controllerHost ? new URL(settings.controllerHost) : null;
  const hosts = new Map<string, Promise<string | undefined>>();
  const hostOf = (index: string) => {
    if (controller?.protocol !== 'http:') return Promise.resolve(undefined);
    let host = hosts.get(index);
    if (!host) {
      host = client.describeIndex(index).then(({ host: reported }) => {
        const url = new URL(`http://${reported}`);
        if (url.hostname !== controller.hostname) throw new Error('index host is elsewhere');
        return url.origin;
      });
      host.catch(() => hosts.delete(index));
      hosts.set(index, host);
    }
    return host;
  };

  return {
    collection(name, dimensions): Collection {
      const index = indexName(name);
      const ns = async (userId: string) => {
        const host = await hostOf(index);
        return client.index({ name: index, namespace: userId, ...(host && { host }) });
      };
      return {
        name: index,
        async ensure() {
          const { indexes = [] } = await client.listIndexes();
          if (indexes.some((existing) => existing.name === index)) return;
          await client.createIndex({
            name: index,
            dimension: dimensions,
            metric: 'cosine',
            spec: { serverless: { cloud, region } },
            waitUntilReady: true,
            suppressConflicts: true,
          });
        },
        async get(userId, ids) {
          if (!ids.length) return [];
          const { records } = await (await ns(userId)).fetch({ ids });
          return Object.values(records).map((record) => ({
            id: record.id,
            vector: record.values ?? null,
            payload: parsePayload(record.metadata?.payload),
          }));
        },
        async upsert(userId, points) {
          if (!points.length) return;
          await (
            await ns(userId)
          ).upsert({
            records: points.map((point) => ({
              id: point.id,
              values: point.vector,
              metadata: { payload: JSON.stringify(point.payload) },
            })),
          });
        },
        async delete(userId, ids) {
          if (ids.length) await (await ns(userId)).deleteMany({ ids });
        },
        async deleteUser(userId) {
          // A namespace that was never written to doesn't exist yet.
          await (await ns(userId)).deleteAll().catch((err: unknown) => {
            if (!/not ?found|404/i.test(String(err))) throw err;
          });
        },
        async query(userId, vector, limit) {
          const { matches } = await (
            await ns(userId)
          ).query({
            vector,
            topK: Math.min(limit, 10_000),
            includeMetadata: true,
          });
          return matches.map((match) => ({
            id: match.id,
            score: match.score ?? 0,
            payload: parsePayload(match.metadata?.payload),
          }));
        },
      };
    },
    async collections() {
      return ((await client.listIndexes()).indexes ?? []).map((index) => index.name);
    },
    async check() {
      await client.listIndexes();
    },
    close: async () => {},
  };
}
