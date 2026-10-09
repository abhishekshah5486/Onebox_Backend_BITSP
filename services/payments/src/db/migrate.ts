import { fileURLToPath } from 'node:url';
import { runMigrations, type PgClient } from '@onebox/db-pg';
import type { Logger } from '@onebox/logger';

// Resolves to services/payments/drizzle from both src/db (dev) and dist (build).
const migrationsFolder = fileURLToPath(
  new URL(import.meta.url.includes('/dist/') ? '../drizzle' : '../../drizzle', import.meta.url),
);

export const PAYMENTS_SCHEMA = 'payments';

export const migratePayments = (client: PgClient, logger: Logger) =>
  runMigrations(client, { migrationsFolder, schema: PAYMENTS_SCHEMA, logger });
