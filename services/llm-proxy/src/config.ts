import { envBoolean, envPoolSize, envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const optionalKey = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const schema = z.object({
  PORT: envPort.default(4006),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres connection string'),
  DATABASE_POOL_MAX: envPoolSize,
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  BILLING_SERVICE_URL: z.url().default('http://localhost:4009'),
  // A provider without a key is skipped; its models show as unavailable.
  OPENAI_API_KEY: optionalKey,
  GEMINI_API_KEY: optionalKey,
  ANTHROPIC_API_KEY: optionalKey,
  PERPLEXITY_API_KEY: optionalKey,
  // Semantic search embeds with this until a user picks another (provider/model).
  EMBEDDING_DEFAULT_MODEL: z
    .string()
    .regex(/^[a-z]+\/.+$/, 'must be provider/model')
    .default('ollama/bge-m3'),
  OLLAMA_URL: z.url().default('http://localhost:11434'),
  // The public catalogue of providers and models users can bring their own keys for.
  PROVIDER_CATALOG_URL: z.url().default('https://models.dev/api.json'),
  // How long a test call with a user's own credentials may take.
  PROVIDER_CHECK_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
  // Lets users point at servers on this machine or its network (e.g. LM Studio); off in production.
  PROVIDER_ALLOW_PRIVATE_URLS: envBoolean.default(false),
  PROVIDER_CATALOG_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 60 * 60_000),
  CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .default(7 * 24 * 60 * 60),
  CALL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
});

export type LlmProxyConfig = z.infer<typeof schema>;

export const loadLlmProxyConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(schema, env);
