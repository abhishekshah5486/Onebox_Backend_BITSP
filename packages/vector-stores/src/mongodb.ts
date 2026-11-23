import { MongoClient, type Document } from 'mongodb';
import { cleanName, fromHalfCosine, type Collection, type VectorStore } from './types';

const collectionName = (name: string) => cleanName(name, { allowed: /[^A-Za-z0-9_-]/g, max: 120 });
const SEARCH_INDEX = 'onebox_vector';

interface Doc {
  _id: string;
  userId: string;
  payload: Record<string, unknown>;
  vector: number[];
}

// Atlas Vector Search: a search index per collection, filtered by user.
export function mongodbStore(settings: Record<string, string>): VectorStore {
  const client = new MongoClient(settings.connectionString ?? '', {
    serverSelectionTimeoutMS: 15_000,
  });
  const db = () => client.db(settings.database || 'onebox');

  return {
    collection(name, dimensions): Collection {
      const named = collectionName(name);
      const coll = () => db().collection<Doc>(named);
      return {
        name: named,
        async ensure() {
          const exists = await db().listCollections({ name: named }, { nameOnly: true }).hasNext();
          if (!exists) await db().createCollection(named);
          const indexes = await coll().listSearchIndexes(SEARCH_INDEX).toArray();
          if (!indexes.length) {
            await coll().createSearchIndex({
              name: SEARCH_INDEX,
              type: 'vectorSearch',
              definition: {
                fields: [
                  {
                    type: 'vector',
                    path: 'vector',
                    numDimensions: dimensions,
                    similarity: 'cosine',
                  },
                  { type: 'filter', path: 'userId' },
                ],
              },
            });
          }
          // The index builds in the background; searches before it's ready find nothing.
          for (let tries = 0; tries < 120; tries += 1) {
            const [index] = (await coll().listSearchIndexes(SEARCH_INDEX).toArray()) as Document[];
            if (index?.queryable) return;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          throw new Error('The Atlas vector index did not become ready');
        },
        async get(userId, ids, withVectors) {
          if (!ids.length) return [];
          const docs = await coll()
            .find({ _id: { $in: ids }, userId }, { projection: withVectors ? {} : { vector: 0 } })
            .toArray();
          return docs.map((doc) => ({
            id: doc._id,
            vector: doc.vector ?? null,
            payload: doc.payload,
          }));
        },
        async upsert(userId, points) {
          if (!points.length) return;
          await coll().bulkWrite(
            points.map((point) => ({
              replaceOne: {
                filter: { _id: point.id },
                replacement: { userId, payload: point.payload, vector: point.vector },
                upsert: true,
              },
            })),
          );
        },
        async delete(userId, ids) {
          if (ids.length) await coll().deleteMany({ _id: { $in: ids }, userId });
        },
        async deleteUser(userId) {
          await coll().deleteMany({ userId });
        },
        async query(userId, vector, limit) {
          const rows = await coll()
            .aggregate<{ _id: string; payload: Record<string, unknown>; score: number }>([
              {
                $vectorSearch: {
                  index: SEARCH_INDEX,
                  path: 'vector',
                  queryVector: vector,
                  numCandidates: Math.min(limit * 10, 10_000),
                  limit,
                  filter: { userId },
                },
              },
              { $project: { payload: 1, score: { $meta: 'vectorSearchScore' } } },
            ])
            .toArray();
          return rows.map((row) => ({
            id: row._id,
            score: fromHalfCosine(row.score),
            payload: row.payload,
          }));
        },
      };
    },
    async collections() {
      return (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    },
    async check() {
      await db().command({ ping: 1 });
      await db().listCollections({}, { nameOnly: true }).toArray();
    },
    close: () => client.close(),
  };
}
