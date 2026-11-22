import { createRemoteTokenVerifier, deriveInternalToken } from '@onebox/auth-kit';
import {
  createJobEnvelope,
  QUEUES,
  type ReembedPayload,
  type UsageEventPayload,
} from '@onebox/contracts';
import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createProducer } from '@onebox/queue';
import { Redis } from 'ioredis';
import { Ollama } from 'ollama';
import { buildApp } from './app';
import { loadLlmProxyConfig } from './config';
import { migrateLlm } from './db/migrate';
import type { Provider } from './db/schema';
import { createBillingClient } from './llm/billing';
import { createBreaker } from './llm/breaker';
import { createCatalog } from './llm/catalog';
import { createCompleter } from './llm/complete';
import { createEmbeddings } from './llm/embed';
import { createProviderDirectory } from './byok/directory';
import { createUserModels } from './byok/user-models';
import { createEmbeddingCatalog } from './llm/embedding-catalog';
import { createUsage } from './llm/usage';
import { anthropicAdapter } from './providers/anthropic';
import { geminiAdapter } from './providers/gemini';
import { perplexityAdapter } from './providers/perplexity';
import { openaiAdapter } from './providers/openai';
import type { ProviderAdapter } from './providers/types';

const logger = createLogger({ service: 'llm-proxy', pretty: process.stdout.isTTY });
const config = loadLlmProxyConfig();
const pg = createPgClient(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
await pg.ping();
await migrateLlm(pg, logger);

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));

const adapters: Partial<Record<Provider, ProviderAdapter>> = {
  ...(config.OPENAI_API_KEY && { OPENAI: openaiAdapter(config.OPENAI_API_KEY) }),
  ...(config.GEMINI_API_KEY && { GEMINI: geminiAdapter(config.GEMINI_API_KEY) }),
  ...(config.ANTHROPIC_API_KEY && { ANTHROPIC: anthropicAdapter(config.ANTHROPIC_API_KEY) }),
  ...(config.PERPLEXITY_API_KEY && {
    PERPLEXITY: perplexityAdapter(config.PERPLEXITY_API_KEY),
  }),
};
// A provider whose key is rejected is left out, so its models show as unavailable.
for (const [provider, adapter] of Object.entries(adapters) as [Provider, ProviderAdapter][]) {
  if (!(await adapter.checkKey())) {
    logger.warn({ provider }, 'api key rejected, leaving this provider out');
    delete adapters[provider];
  }
}
// Postgres is a slow round trip away and idle connections are retired after 20s, so two are kept
// warm; otherwise a settings page waits seconds for a fresh connection.
const warm = setInterval(() => void Promise.all([pg.ping(), pg.ping()]).catch(() => {}), 15_000);
warm.unref();

const directory = createProviderDirectory({
  db: pg.db,
  url: config.PROVIDER_CATALOG_URL,
  ttlMs: config.PROVIDER_CATALOG_TTL_MS,
  logger,
});

// Models users add with their own keys.
const userModels = createUserModels({
  db: pg.db,
  encryptionKey: config.CREDENTIALS_ENCRYPTION_KEY,
  directory,
  allowPrivateUrls: config.PROVIDER_ALLOW_PRIVATE_URLS,
  timeoutMs: config.PROVIDER_CHECK_TIMEOUT_MS,
  logger,
});

const catalog = createCatalog(pg.db, new Set(Object.keys(adapters) as Provider[]), (userId, id) =>
  userModels.owns(userId, id, 'llm'),
);
logger.info({ providers: Object.keys(adapters) }, 'language model providers configured');

const internalToken = deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY);
// Each paid call goes to billing, which takes the credits.
const usageEvents = createProducer<UsageEventPayload>(QUEUES.usage, {
  redisUrl: config.REDIS_URL,
  logger,
});
const billing = createBillingClient({
  baseUrl: config.BILLING_SERVICE_URL,
  internalToken,
  usage: usageEvents,
  logger,
});

const embeddingCatalog = createEmbeddingCatalog({
  db: pg.db,
  ollama: new Ollama({ host: config.OLLAMA_URL }),
  ollamaUrl: config.OLLAMA_URL,
  // Only providers whose key was accepted above.
  keys: {
    ...(adapters.OPENAI && { OPENAI: config.OPENAI_API_KEY }),
    ...(adapters.GEMINI && { GEMINI: config.GEMINI_API_KEY }),
  },
  defaultModel: config.EMBEDDING_DEFAULT_MODEL,
  logger,
  userModels,
});
const reembedJobs = createProducer<ReembedPayload>(QUEUES.reembed, {
  redisUrl: config.REDIS_URL,
  logger,
});

const app = buildApp({
  logger,
  checks: { postgres: pg.ping, redis: () => redis.ping() },
  routes: {
    catalog,
    complete: createCompleter({
      db: pg.db,
      redis,
      catalog,
      breaker: createBreaker(redis),
      adapters,
      logger,
      cacheTtlSeconds: config.CACHE_TTL_SECONDS,
      timeoutMs: config.CALL_TIMEOUT_MS,
      billing,
      userModels,
    }),
    embed: createEmbeddings({ catalog: embeddingCatalog, billing, logger }),
    embeddingCatalog,
    directory,
    userModels,
    reembed: async (userId, modelId) => {
      await reembedJobs.enqueue(
        createJobEnvelope({
          jobId: `reembed-${userId}-${Date.now()}`,
          userId,
          payload: { modelId },
        }),
      );
    },
    usage: createUsage(pg.db),
    verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
    internalToken,
  },
});
await startServer(app, {
  port: config.PORT,
  cleanups: [pg.close, () => redis.quit(), usageEvents.close, reembedJobs.close],
});
