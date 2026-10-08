import { fileURLToPath } from 'node:url';
import { runMigrations, type PgClient } from '@onebox/db-pg';
import type { Logger } from '@onebox/logger';

// Resolves to services/llm-proxy/drizzle from both src/db (dev) and dist (build).
const migrationsFolder = fileURLToPath(
  new URL(import.meta.url.includes('/dist/') ? '../drizzle' : '../../drizzle', import.meta.url),
);

export const LLM_SCHEMA = 'llm';

export const migrateLlm = (client: PgClient, logger: Logger) =>
  runMigrations(client, { migrationsFolder, schema: LLM_SCHEMA, logger });
