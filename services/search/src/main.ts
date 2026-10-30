import { Client } from '@elastic/elasticsearch';
import { createRemoteTokenVerifier, deriveInternalToken } from '@onebox/auth-kit';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { createEmbedClient } from './clients/embed-client';
import { createThreadLookup } from './clients/mail-client';
import { loadSearchConfig } from './config';
import { createKeywordIndex } from './keyword/keyword-index';
import { createVectorIndex } from './semantic/vector-index';
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

const keyword = createKeywordIndex(elastic, config.ELASTICSEARCH_INDEX);
const vector = createVectorIndex(qdrant, config.QDRANT_COLLECTION, config.EMBEDDING_DIMENSIONS);
await keyword.ensure();
await vector.ensure();

const embed = createEmbedClient(
  config.LLM_PROXY_SERVICE_URL,
  deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY),
);
const workers = startWorkers({
  redisUrl: config.REDIS_URL,
  logger,
  keyword,
  vector,
  embed,
  indexConcurrency: config.INDEX_CONCURRENCY,
  embedConcurrency: config.EMBED_CONCURRENCY,
});

const app = buildApp({
  logger,
  checks: {
    redis: () => redis.ping(),
    elasticsearch: () => keyword.ping(),
    qdrant: () => vector.ping(),
  },
  keyword,
  vector,
  embed,
  lookupThreads: createThreadLookup(config.MAIL_SERVICE_URL),
  verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
});
await startServer(app, {
  port: config.PORT,
  cleanups: [() => workers.close(), () => elastic.close(), () => redis.quit()],
});
