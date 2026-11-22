import { envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4011),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  MAIL_SERVICE_URL: z.url().default('http://localhost:4003'),
  LLM_PROXY_SERVICE_URL: z.url().default('http://localhost:4006'),
  // Says where each user keeps their vectors.
  SETTINGS_SERVICE_URL: z.url().default('http://localhost:4004'),
  // Signs calls to llm-proxy for embeddings.
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  ELASTICSEARCH_URL: z.url().default('http://localhost:9200'),
  ELASTICSEARCH_INDEX: z.string().min(1).default('mail-messages'),
  QDRANT_URL: z.url().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().min(1).optional(),
  INDEX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  EMBED_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
});

export type SearchConfig = z.infer<typeof schema>;

export const loadSearchConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(schema, env);
