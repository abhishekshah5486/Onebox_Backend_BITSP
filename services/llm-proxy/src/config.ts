import { envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const optionalKey = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const schema = z.object({
  PORT: envPort.default(4006),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres connection string'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  BILLING_SERVICE_URL: z.url().default('http://localhost:4009'),
  // A provider without a key is skipped; its models show as unavailable.
  OPENAI_API_KEY: optionalKey,
  GEMINI_API_KEY: optionalKey,
  ANTHROPIC_API_KEY: optionalKey,
  PERPLEXITY_API_KEY: optionalKey,
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
