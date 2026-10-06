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
  const sql = postgres(url, { max, onnotice: () => {} });
  return {
    db: drizzle(sql),
    ping: async () => {
      await sql`select 1`;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

// Each service keeps its own migration history inside its own schema.
export async function runMigrations(
  client: PgClient,
  {
    migrationsFolder,
    schema,
    logger,
  }: { migrationsFolder: string; schema: string; logger: Logger },
) {
  const startedAt = Date.now();
  await migrate(client.db, { migrationsFolder, migrationsSchema: schema });
  logger.info({ schema, durationMs: Date.now() - startedAt }, 'database migrations applied');
}
