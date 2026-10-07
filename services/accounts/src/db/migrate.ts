import { fileURLToPath } from 'node:url';
import { runMigrations, type PgClient } from '@onebox/db-pg';
import type { Logger } from '@onebox/logger';

// Resolves to services/accounts/drizzle from both src/db (dev) and dist (build).
const migrationsFolder = fileURLToPath(
  new URL(import.meta.url.includes('/dist/') ? '../drizzle' : '../../drizzle', import.meta.url),
);

export const ACCOUNTS_SCHEMA = 'accounts';

export const migrateAccounts = (client: PgClient, logger: Logger) =>
  runMigrations(client, { migrationsFolder, schema: ACCOUNTS_SCHEMA, logger });
