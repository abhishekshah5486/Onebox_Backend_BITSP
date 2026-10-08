import { createRemoteTokenVerifier, deriveInternalToken } from '@onebox/auth-kit';
import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { loadLlmProxyConfig } from './config';
import { migrateLlm } from './db/migrate';
import type { Provider } from './db/schema';
import { createBreaker } from './llm/breaker';
import { createCatalog } from './llm/catalog';
import { createCompleter } from './llm/complete';
import { createUsage } from './llm/usage';
import { anthropicAdapter } from './providers/anthropic';
import { geminiAdapter } from './providers/gemini';
import { openaiAdapter } from './providers/openai';
import type { ProviderAdapter } from './providers/types';

const logger = createLogger({ service: 'llm-proxy', pretty: process.stdout.isTTY });
const config = loadLlmProxyConfig();
const pg = createPgClient(config.DATABASE_URL);
await pg.ping();
await migrateLlm(pg, logger);

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));

const adapters: Partial<Record<Provider, ProviderAdapter>> = {
  ...(config.OPENAI_API_KEY && { OPENAI: openaiAdapter(config.OPENAI_API_KEY) }),
  ...(config.GEMINI_API_KEY && { GEMINI: geminiAdapter(config.GEMINI_API_KEY) }),
  ...(config.ANTHROPIC_API_KEY && { ANTHROPIC: anthropicAdapter(config.ANTHROPIC_API_KEY) }),
};
// A provider whose key is rejected is left out, so its models show as unavailable.
for (const [provider, adapter] of Object.entries(adapters) as [Provider, ProviderAdapter][]) {
  if (!(await adapter.checkKey())) {
    logger.warn({ provider }, 'api key rejected, leaving this provider out');
    delete adapters[provider];
  }
}
const catalog = createCatalog(pg.db, new Set(Object.keys(adapters) as Provider[]));
logger.info({ providers: Object.keys(adapters) }, 'language model providers configured');

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
    }),
    usage: createUsage(pg.db),
    verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
    internalToken: deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY),
  },
});
await startServer(app, { port: config.PORT, cleanups: [pg.close, () => redis.quit()] });
