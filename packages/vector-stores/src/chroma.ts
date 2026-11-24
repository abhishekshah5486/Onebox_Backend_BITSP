import { ChromaClient, type Collection as ChromaCollection } from 'chromadb';
import { cleanName, parsePayload, type Collection, type VectorStore } from './types';

const collectionName = (name: string) => cleanName(name, { allowed: /[^A-Za-z0-9._-]/g, max: 512 });

export function chromaStore(settings: Record<string, string>): VectorStore {
  const url = new URL(settings.url ?? 'http://localhost:8000');
  const ssl = url.protocol === 'https:';
  const client = new ChromaClient({
    host: url.hostname,
    port: Number(url.port) || (ssl ? 443 : 80),
    ssl,
    ...(settings.apiKey && { headers: { 'x-chroma-token': settings.apiKey } }),
  });

  return {
    collection(name): Collection {
      const named = collectionName(name);
      let handle: Promise<ChromaCollection> | null = null;
      // Vectors come from OneBox, so Chroma is given no embedding function.
      const open = () => {
        handle ??= client.getOrCreateCollection({
          name: named,
          embeddingFunction: null,
          configuration: { hnsw: { space: 'cosine' } },
        });
        handle.catch(() => (handle = null));
        return handle;
      };
      return {
        name: named,
        async ensure() {
          await open();
        },
        async get(_userId, ids, withVectors) {
          if (!ids.length) return [];
          const result = await (
            await open()
          ).get({
            ids,
            include: withVectors ? ['metadatas', 'embeddings'] : ['metadatas'],
          });
          return result.ids.map((id, i) => ({
            id,
            vector: result.embeddings[i] ?? null,
            payload: parsePayload(result.metadatas[i]?.payload),
          }));
        },
        async upsert(userId, points) {
          if (!points.length) return;
          await (
            await open()
          ).upsert({
            ids: points.map((point) => point.id),
            embeddings: points.map((point) => point.vector),
            metadatas: points.map((point) => ({ userId, payload: JSON.stringify(point.payload) })),
          });
        },
        async delete(_userId, ids) {
          if (ids.length) await (await open()).delete({ ids });
        },
        async deleteUser(userId) {
          await (await open()).delete({ where: { userId } });
        },
        async query(userId, vector, limit) {
          const result = await (
            await open()
          ).query({
            queryEmbeddings: [vector],
            nResults: limit,
            where: { userId },
            include: ['metadatas', 'distances'],
          });
          return (result.ids[0] ?? []).map((id, i) => ({
            id,
            score: 1 - (result.distances[0]?.[i] ?? 1),
            payload: parsePayload(result.metadatas[0]?.[i]?.payload),
          }));
        },
      };
    },
    async collections() {
      const found: string[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await client.listCollections({ limit: 100, offset });
        found.push(...page.map((collection) => collection.name));
        if (page.length < 100) return found;
      }
    },
    async check() {
      await client.heartbeat();
      await client.listCollections({ limit: 1 });
    },
    close: async () => {},
  };
}
