import { envPort, loadConfig } from '@onebox/config';
import { blobConfigSchema } from '@onebox/blob-store';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4003),
  MONGO_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb connection string'),
  MONGO_DB: z.string().min(1).default('onebox_mail'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  // api = HTTP only, worker = ingest queue only, all = both (local dev).
  MAIL_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  INGEST_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  ...blobConfigSchema,
});

export type MailConfig = z.infer<typeof schema>;

export const loadMailConfig = (env?: Record<string, string | undefined>) => loadConfig(schema, env);
