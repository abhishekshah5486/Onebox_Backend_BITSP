import { Client } from '@elastic/elasticsearch';
import { createRemoteTokenVerifier, deriveInternalToken } from '@onebox/auth-kit';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { createEmbedClient, fetchEmbedModel } from './clients/embed-client';
import { createThreadLookup } from './clients/mail-client';
import { loadSearchConfig } from './config';
import { createIndexState } from './index-state';
import { createKeywordIndex } from './keyword/keyword-index';
import { createSemanticModels } from './semantic/models';
import { startWorkers } from './workers';

const logger = createLogger({ service: 'search', pretty: process.stdout.isTTY });
const config = loadSearchConfig();

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
const elastic = new Client({ node: config.ELASTICSEARCH_URL });
const qdrant = new QdrantClient({
  url: config.QDRANT_URL,
  ...(config.QDRANT_API_KEY && { apiKey: config.QDRANT_API_KEY }),
});

const internalToken = deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY);
const defaultModel = await fetchEmbedModel(config.LLM_PROXY_SERVICE_URL, internalToken, {
  onRetry: (err) => logger.warn({ err: err.message }, 'waiting for llm-proxy'),
});
logger.info({ model: defaultModel.id }, 'default embedding model');

const keyword = createKeywordIndex(elastic, config.ELASTICSEARCH_INDEX);
await keyword.ensure();
const models = createSemanticModels({
  qdrant,
  redis,
  fetchModel: (userId) =>
    fetchEmbedModel(config.LLM_PROXY_SERVICE_URL, internalToken, { userId, retries: 2 }),
  defaultModel,
});
await models.indexFor(defaultModel);

const embed = createEmbedClient(config.LLM_PROXY_SERVICE_URL, internalToken);
const workers = startWorkers({
  redisUrl: config.REDIS_URL,
  logger,
  keyword,
  models,
  embed,
  state: createIndexState(redis),
  indexConcurrency: config.INDEX_CONCURRENCY,
  embedConcurrency: config.EMBED_CONCURRENCY,
});

const app = buildApp({
  logger,
  checks: {
    redis: () => redis.ping(),
    elasticsearch: () => keyword.ping(),
    qdrant: () => qdrant.versionInfo(),
  },
  keyword,
  models,
  embed,
  lookupThreads: createThreadLookup(config.MAIL_SERVICE_URL),
  verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
});
await startServer(app, {
  port: config.PORT,
  cleanups: [() => workers.close(), () => elastic.close(), () => redis.quit()],
});
