import neo4j from 'neo4j-driver';
import { cleanName, fromHalfCosine, type Collection, type VectorStore } from './types';

const labelOf = (name: string) => cleanName(name, { allowed: /[^A-Za-z0-9_]/g, max: 200 });

// A node label per collection, with a vector index on it.
export function neo4jStore(settings: Record<string, string>): VectorStore {
  const driver = neo4j.driver(
    settings.url ?? '',
    neo4j.auth.basic(settings.username || 'neo4j', settings.password ?? ''),
    { connectionTimeout: 15_000 },
  );
  const run = async <T>(query: string, params: Record<string, unknown> = {}) => {
    const session = driver.session(settings.database ? { database: settings.database } : {});
    try {
      return (await session.run(query, params)).records.map((record) => record.toObject() as T);
    } finally {
      await session.close();
    }
  };

  return {
    collection(name, dimensions): Collection {
      const label = labelOf(name);
      const index = `${label}_vector`;
      return {
        name: label,
        async ensure() {
          await run(
            `CREATE CONSTRAINT \`${label}_id\` IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE n.id IS UNIQUE`,
          );
          await run(
            `CREATE VECTOR INDEX \`${index}\` IF NOT EXISTS FOR (n:\`${label}\`) ON n.vector
             OPTIONS { indexConfig: { \`vector.dimensions\`: ${Math.trunc(dimensions)}, \`vector.similarity_function\`: 'cosine' } }`,
          );
          await run('CALL db.awaitIndexes(120)');
        },
        async get(userId, ids, withVectors) {
          if (!ids.length) return [];
          const rows = await run<{ id: string; payload: string; vector: number[] | null }>(
            `MATCH (n:\`${label}\`) WHERE n.id IN $ids AND n.userId = $userId
             RETURN n.id AS id, n.payload AS payload, ${withVectors ? 'n.vector' : 'null'} AS vector`,
            { ids, userId },
          );
          return rows.map((row) => ({
            id: row.id,
            vector: row.vector,
            payload: JSON.parse(row.payload) as Record<string, unknown>,
          }));
        },
        async upsert(userId, points) {
          if (!points.length) return;
          await run(
            `UNWIND $rows AS row MERGE (n:\`${label}\` {id: row.id})
             SET n.userId = $userId, n.payload = row.payload, n.vector = row.vector`,
            {
              userId,
              rows: points.map((point) => ({
                id: point.id,
                payload: JSON.stringify(point.payload),
                vector: point.vector,
              })),
            },
          );
        },
        async delete(userId, ids) {
          if (!ids.length) return;
          await run(
            `MATCH (n:\`${label}\`) WHERE n.id IN $ids AND n.userId = $userId DETACH DELETE n`,
            { ids, userId },
          );
        },
        async deleteUser(userId) {
          await run(`MATCH (n:\`${label}\` {userId: $userId}) DETACH DELETE n`, { userId });
        },
        async query(userId, vector, limit) {
          const rows = await run<{ id: string; payload: string; score: number }>(
            `CALL db.index.vector.queryNodes($index, $k, $vector) YIELD node, score
             WHERE node.userId = $userId
             RETURN node.id AS id, node.payload AS payload, score`,
            { index, k: neo4j.int(limit), vector, userId },
          );
          return rows.map((row) => ({
            id: row.id,
            score: fromHalfCosine(row.score),
            payload: JSON.parse(row.payload) as Record<string, unknown>,
          }));
        },
      };
    },
    async collections() {
      const rows = await run<{ labels: string[] }>(
        "SHOW INDEXES YIELD type, labelsOrTypes WHERE type = 'VECTOR' RETURN labelsOrTypes AS labels",
      );
      return rows.flatMap((row) => row.labels);
    },
    async check() {
      await driver.verifyAuthentication();
      await run('RETURN 1');
    },
    close: () => driver.close(),
  };
}
