import { Redis } from 'ioredis';
import { cleanName, StoreCheckError, type Collection, type VectorStore } from './types';

const indexName = (name: string) => cleanName(name, { allowed: /[^A-Za-z0-9_-]/g, max: 200 });
// Dashes are special in TAG queries.
const tag = (value: string) => value.replace(/[^\w]/g, (c) => `\\${c}`);
const blob = (vector: number[]) => Buffer.from(new Float32Array(vector).buffer);
// Copied first: a slice of Node's buffer pool may not start on a 4-byte boundary.
const unblob = (buffer: Buffer) => Array.from(new Float32Array(Uint8Array.from(buffer).buffer));

const text = (value: unknown) => (Buffer.isBuffer(value) ? value.toString() : String(value));
const pairs = (list: unknown) => {
  const map = new Map<string, string>();
  const items = Array.isArray(list) ? list : [];
  for (let i = 0; i + 1 < items.length; i += 2) map.set(text(items[i]), text(items[i + 1]));
  return map;
};

// FT.SEARCH rows as key and fields, from either reply format: RESP2's flat
// [total, key, fields, …] or RESP3's map with a "results" list.
function searchRows(reply: unknown): { key: string; fields: Map<string, string> }[] {
  const items = Array.isArray(reply) ? reply : [];
  if (typeof items[0] === 'number') {
    const rows = [];
    for (let i = 1; i < items.length; i += 1) {
      const fields = Array.isArray(items[i + 1]) ? pairs(items[i + 1]) : new Map<string, string>();
      rows.push({ key: text(items[i]), fields });
      if (Array.isArray(items[i + 1])) i += 1;
    }
    return rows;
  }
  const at = items.findIndex((item) => text(item) === 'results');
  const results = (at >= 0 ? items[at + 1] : []) as unknown[][];
  return results.map((row) => {
    const entry = pairs(row);
    const attributes = row[row.findIndex((part) => text(part) === 'extra_attributes') + 1];
    return { key: entry.get('id') ?? '', fields: pairs(attributes) };
  });
}

// Redis Query Engine (Redis 8, Redis Stack or Redis Cloud): a hash per email, one index each.
export function redisStore(settings: Record<string, string>): VectorStore {
  const client = new Redis(settings.url ?? '', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 10_000,
  });

  return {
    collection(name, dimensions): Collection {
      const index = indexName(name);
      const key = (id: string) => `${index}:${id}`;
      return {
        name: index,
        async ensure() {
          try {
            await client.call('FT.INFO', index);
          } catch (err) {
            if (!/unknown index|no such index|not found/i.test(String(err))) throw err;
            await client
              .call(
                'FT.CREATE',
                index,
                'ON',
                'HASH',
                'PREFIX',
                '1',
                `${index}:`,
                'SCHEMA',
                'userId',
                'TAG',
                'vector',
                'VECTOR',
                'HNSW',
                '6',
                'TYPE',
                'FLOAT32',
                'DIM',
                String(dimensions),
                'DISTANCE_METRIC',
                'COSINE',
              )
              .catch((error: unknown) => {
                if (!/already exists/i.test(String(error))) throw error;
              });
          }
        },
        async get(userId, ids, withVectors) {
          const found = [];
          for (const id of ids) {
            const hash = await client.hgetallBuffer(key(id));
            if (!hash.payload || hash.userId?.toString() !== userId) continue;
            found.push({
              id,
              vector: withVectors && hash.vector ? unblob(hash.vector) : null,
              payload: JSON.parse(hash.payload.toString()) as Record<string, unknown>,
            });
          }
          return found;
        },
        async upsert(userId, points) {
          if (!points.length) return;
          const pipeline = client.pipeline();
          for (const point of points) {
            pipeline.hset(key(point.id), {
              userId,
              payload: JSON.stringify(point.payload),
              vector: blob(point.vector),
            });
          }
          await pipeline.exec();
        },
        async delete(_userId, ids) {
          if (ids.length) await client.del(...ids.map(key));
        },
        async deleteUser(userId) {
          for (;;) {
            const result = await client.callBuffer(
              'FT.SEARCH',
              index,
              `@userId:{${tag(userId)}}`,
              'NOCONTENT',
              'LIMIT',
              '0',
              '1000',
              'DIALECT',
              '2',
            );
            const keys = searchRows(result)
              .map((row) => row.key)
              .filter(Boolean);
            if (!keys.length) return;
            await client.del(...keys);
          }
        },
        async query(userId, vector, limit) {
          const result = await client.callBuffer(
            'FT.SEARCH',
            index,
            `(@userId:{${tag(userId)}})=>[KNN ${limit} @vector $v AS dist]`,
            'PARAMS',
            '2',
            'v',
            blob(vector),
            'SORTBY',
            'dist',
            'RETURN',
            '2',
            'payload',
            'dist',
            'LIMIT',
            '0',
            String(limit),
            'DIALECT',
            '2',
          );
          return searchRows(result).map(({ key, fields }) => ({
            id: key.slice(index.length + 1),
            score: 1 - Number(fields.get('dist') ?? 1),
            payload: JSON.parse(fields.get('payload') ?? '{}') as Record<string, unknown>,
          }));
        },
      };
    },
    async collections() {
      return ((await client.call('FT._LIST')) as string[]).map(String);
    },
    async check() {
      await client.ping();
      try {
        await client.call('FT._LIST');
      } catch (err) {
        if (/unknown command/i.test(String(err))) {
          throw new StoreCheckError(
            'This Redis has no vector search; use Redis 8, Redis Stack or Redis Cloud',
          );
        }
        throw err;
      }
    },
    async close() {
      client.disconnect();
    },
  };
}
