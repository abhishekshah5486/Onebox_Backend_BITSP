import { envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4009),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres connection string'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  // What a credit is worth: a model call costing $1 uses this many credits.
  CREDITS_PER_USD: z.coerce.number().positive().default(200),
});

export type BillingConfig = z.infer<typeof schema>;

export const loadBillingConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(schema, env);
