import { ConsistencyLevelEnum, DataType, MilvusClient } from '@zilliz/milvus2-sdk-node';
import { cleanName, parsePayload, type Collection, type VectorStore } from './types';

const collectionName = (name: string) => cleanName(name, { allowed: /[^A-Za-z0-9_]/g, max: 255 });
// Ids and user ids are UUIDs; anything else is refused rather than quoted.
const quoted = (values: string[]) => {
  for (const value of values) {
    if (!/^[\w-]+$/.test(value)) throw new Error(`unexpected id ${value}`);
  }
  return values.map((value) => `"${value}"`).join(', ');
};

export function milvusStore(settings: Record<string, string>): VectorStore {
  const client = new MilvusClient({
    address: settings.address ?? '',
    ...(settings.token && { token: settings.token }),
    timeout: 30_000,
  });
  const ok = (status: { error_code?: string | number; reason?: string }) => {
    if (
      status.error_code !== undefined &&
      status.error_code !== 'Success' &&
      status.error_code !== 0
    ) {
      throw new Error(status.reason || String(status.error_code));
    }
  };

  return {
    collection(name, dimensions): Collection {
      const collection_name = collectionName(name);
      return {
        name: collection_name,
        async ensure() {
          const has = await client.hasCollection({ collection_name });
          if (!has.value) {
            ok(
              await client.createCollection({
                collection_name,
                fields: [
                  { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
                  { name: 'userId', data_type: DataType.VarChar, max_length: 64 },
                  { name: 'payload', data_type: DataType.VarChar, max_length: 65_535 },
                  { name: 'vector', data_type: DataType.FloatVector, dim: dimensions },
                ],
              }),
            );
            ok(
              await client.createIndex({
                collection_name,
                field_name: 'vector',
                index_type: 'AUTOINDEX',
                metric_type: 'COSINE',
              }),
            );
          }
          ok(await client.loadCollectionSync({ collection_name }));
        },
        async get(_userId, ids, withVectors) {
          if (!ids.length) return [];
          const result = await client.query({
            collection_name,
            filter: `id in [${quoted(ids)}]`,
            output_fields: ['id', 'payload', ...(withVectors ? ['vector'] : [])],
            consistency_level: ConsistencyLevelEnum.Strong,
          });
          ok(result.status);
          return result.data.map((row) => ({
            id: String(row.id),
            vector: (row.vector as number[] | undefined) ?? null,
            payload: parsePayload(row.payload),
          }));
        },
        async upsert(userId, points) {
          if (!points.length) return;
          ok(
            (
              await client.upsert({
                collection_name,
                data: points.map((point) => ({
                  id: point.id,
                  userId,
                  payload: JSON.stringify(point.payload),
                  vector: point.vector,
                })),
              })
            ).status,
          );
        },
        async delete(_userId, ids) {
          if (!ids.length) return;
          ok((await client.delete({ collection_name, filter: `id in [${quoted(ids)}]` })).status);
        },
        async deleteUser(userId) {
          ok(
            (await client.delete({ collection_name, filter: `userId == ${quoted([userId])}` }))
              .status,
          );
        },
        async query(userId, vector, limit) {
          const result = await client.search({
            collection_name,
            data: [vector],
            limit: Math.min(limit, 16_384),
            filter: `userId == ${quoted([userId])}`,
            output_fields: ['id', 'payload'],
            metric_type: 'COSINE',
            consistency_level: ConsistencyLevelEnum.Strong,
          });
          ok(result.status);
          type Row = { id: string; score: number; payload: string };
          // One query vector may come back as one list of rows or as a list holding it.
          const rows = result.results as unknown as Row[] | Row[][];
          const flat = (Array.isArray(rows[0]) ? rows[0] : rows) as Row[];
          return flat.map((row) => ({
            id: String(row.id),
            score: row.score,
            payload: parsePayload(row.payload),
          }));
        },
      };
    },
    async collections() {
      const result = await client.showCollections();
      ok(result.status);
      return result.data.map((collection) => collection.name);
    },
    async check() {
      ok((await client.showCollections()).status);
    },
    async close() {
      await client.closeConnection();
    },
  };
}
