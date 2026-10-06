import type { Logger } from '@onebox/logger';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export interface PgClient {
  db: PostgresJsDatabase;
  // A separate single-connection client, for work that needs one session (e.g. advisory locks).
  dedicated: () => postgres.Sql;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

export function createPgClient(url: string, { max = 10 }: { max?: number } = {}): PgClient {
  // Encrypt when the server supports it (Supabase); local containers fall back to plain TCP.
  const options = {
    onnotice: () => {},
    ...(!url.includes('sslmode=') && { ssl: 'prefer' as const }),
  };
  const sql = postgres(url, { ...options, max });
  return {
    db: drizzle(sql),
    dedicated: () => postgres(url, { ...options, max: 1 }),
    ping: async () => {
      await sql`select 1`;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

// Histories live in a shared "drizzle" schema (one table per service) so a service's
// first migration can still create its own schema.
export async function runMigrations(
  client: PgClient,
  {
    migrationsFolder,
    schema,
    logger,
  }: { migrationsFolder: string; schema: string; logger: Logger },
) {
  const startedAt = Date.now();
  const lockKey = `migrations:${schema}`;
  // A session advisory lock serialises replicas that start at the same time.
  const connection = client.dedicated();
  try {
    await connection`select pg_advisory_lock(hashtext(${lockKey}))`;
    await migrate(drizzle(connection), {
      migrationsFolder,
      migrationsSchema: 'drizzle',
      migrationsTable: `${schema}_migrations`,
    });
  } finally {
    await connection.end({ timeout: 5 });
  }
  logger.info({ schema, durationMs: Date.now() - startedAt }, 'database migrations applied');
}
