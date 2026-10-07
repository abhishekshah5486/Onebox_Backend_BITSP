import { envBoolean, envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4005),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  ACCOUNTS_SERVICE_URL: z.url().default('http://localhost:4002'),
  SETTINGS_SERVICE_URL: z.url().default('http://localhost:4004'),
  ALLOW_PRIVATE_MAIL_HOSTS: envBoolean.default(false),
  BACKFILL_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  // Fetching pauses while more than this many ingest jobs are waiting (backpressure).
  INGEST_HIGH_WATERMARK: z.coerce.number().int().min(10).default(500),
});

export type ConnectorConfig = z.infer<typeof schema>;

export const loadConnectorConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(schema, env);
