import postgres from 'postgres';
import { cleanName, StoreCheckError, type Collection, type VectorStore } from './types';

const tableName = (name: string) =>
  cleanName(name.toLowerCase(), { allowed: /[^a-z0-9_]/g, max: 63 });
const literal = (vector: number[]) => `[${vector.join(',')}]`;
const parseVector = (text: string) => JSON.parse(text) as number[];

// A table per collection in the database the connection string names.
export function pgvectorStore(settings: Record<string, string>): VectorStore {
  const sql = postgres(settings.connectionString ?? '', {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });

  return {
    collection(name, dimensions): Collection {
      const table = tableName(name);
      return {
        name: table,
        async ensure() {
          await sql`create extension if not exists vector`;
          await sql.unsafe(
            `create table if not exists "${table}" (
              id uuid primary key,
              user_id text not null,
              payload jsonb not null,
              embedding vector(${Math.trunc(dimensions)}) not null
            )`,
          );
          await sql.unsafe(`create index if not exists "${table}_user" on "${table}" (user_id)`);
          await sql.unsafe(
            `create index if not exists "${table}_hnsw" on "${table}" using hnsw (embedding vector_cosine_ops)`,
          );
        },
        async get(userId, ids, withVectors) {
          if (!ids.length) return [];
          const rows = await sql<
            { id: string; payload: Record<string, unknown>; embedding: string | null }[]
          >`
            select id, payload, ${withVectors ? sql`embedding::text` : sql`null`} as embedding
            from ${sql(table)} where user_id = ${userId} and id = any(${ids}::uuid[])`;
          return rows.map((row) => ({
            id: row.id,
            vector: row.embedding ? parseVector(row.embedding) : null,
            payload: row.payload,
          }));
        },
        async upsert(userId, points) {
          for (const point of points) {
            await sql`
              insert into ${sql(table)} (id, user_id, payload, embedding)
              values (${point.id}, ${userId}, ${sql.json(point.payload as never)}, ${literal(point.vector)}::vector)
              on conflict (id) do update set
                user_id = excluded.user_id, payload = excluded.payload, embedding = excluded.embedding`;
          }
        },
        async delete(userId, ids) {
          if (ids.length) {
            await sql`delete from ${sql(table)} where user_id = ${userId} and id = any(${ids}::uuid[])`;
          }
        },
        async deleteUser(userId) {
          await sql`delete from ${sql(table)} where user_id = ${userId}`;
        },
        async query(userId, vector, limit) {
          const rows = await sql<{ id: string; payload: Record<string, unknown>; score: number }[]>`
            select id, payload, 1 - (embedding <=> ${literal(vector)}::vector) as score
            from ${sql(table)} where user_id = ${userId}
            order by embedding <=> ${literal(vector)}::vector limit ${limit}`;
          return rows.map((row) => ({
            id: row.id,
            score: Number(row.score),
            payload: row.payload,
          }));
        },
      };
    },
    async collections() {
      const rows = await sql<{ name: string }[]>`
        select table_name as name from information_schema.tables
        where table_schema = current_schema()`;
      return rows.map((row) => row.name);
    },
    async check() {
      await sql`select 1`;
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_available_extensions where name = 'vector'`;
      if (!row?.n) throw new StoreCheckError('This Postgres has no pgvector extension');
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
