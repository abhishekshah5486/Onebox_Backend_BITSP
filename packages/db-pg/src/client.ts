import type { Logger } from '@onebox/logger';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export interface PgClient {
  db: PostgresJsDatabase;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

export function createPgClient(url: string, { max = 10 }: { max?: number } = {}): PgClient {
  // Encrypt when the server supports it (Supabase); local containers fall back to plain TCP.
  const ssl = url.includes('sslmode=') ? undefined : 'prefer';
  const sql = postgres(url, { max, onnotice: () => {}, ...(ssl && { ssl }) });
  return {
    db: drizzle(sql),
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
  await migrate(client.db, {
    migrationsFolder,
    migrationsSchema: 'drizzle',
    migrationsTable: `${schema}_migrations`,
  });
  logger.info({ schema, durationMs: Date.now() - startedAt }, 'database migrations applied');
}
