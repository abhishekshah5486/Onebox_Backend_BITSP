import { envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4007),
  MONGO_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb connection string'),
  MONGO_AI_DB: z.string().min(1).default('onebox_ai'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  LLM_PROXY_SERVICE_URL: z.url().default('http://localhost:4006'),
  AI_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
});

export type AiConfig = z.infer<typeof schema>;

export const loadAiConfig = (env?: Record<string, string | undefined>) => loadConfig(schema, env);
