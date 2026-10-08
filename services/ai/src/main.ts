import { createRemoteTokenVerifier, deriveInternalToken } from '@onebox/auth-kit';
import { aiClassifyPayloadSchema, QUEUES, type MailboxChangePayload } from '@onebox/contracts';
import { connectMongo } from '@onebox/db-mongo';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createConsumer, createProducer } from '@onebox/queue';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { createClassifyHandler } from './classify/classify';
import { createLlmClient } from './classify/llm-client';
import { loadAiConfig } from './config';
import { aiCollections, ensureIndexes } from './db/collections';
import { createLabelRules } from './labels/label-rules';
import { createSuggestions } from './suggestions/suggestions';

const logger = createLogger({ service: 'ai', pretty: process.stdout.isTTY });
const config = loadAiConfig();

const mongo = await connectMongo(config.MONGO_URI, config.MONGO_AI_DB);
const collections = aiCollections(mongo.db);
await ensureIndexes(collections);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));

// Labels put on by AI or the user reach the mail service as mailbox changes.
const changes = createProducer<MailboxChangePayload>(QUEUES.mailboxChanges, {
  redisUrl: config.REDIS_URL,
  logger,
});
const classify = createConsumer(
  QUEUES.ai,
  aiClassifyPayloadSchema,
  createClassifyHandler({
    collections,
    llm: createLlmClient(
      config.LLM_PROXY_SERVICE_URL,
      deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY),
    ),
    changes,
  }),
  { redisUrl: config.REDIS_URL, logger, concurrency: config.AI_CONCURRENCY },
);
logger.info({ concurrency: config.AI_CONCURRENCY }, 'classification worker started');

const app = buildApp({
  logger,
  checks: { mongodb: mongo.ping, redis: () => redis.ping() },
  routes: {
    labels: createLabelRules(collections),
    suggestions: createSuggestions({ collections, changes, logger }),
    verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
  },
});
await startServer(app, {
  port: config.PORT,
  cleanups: [classify.close, changes.close, mongo.close, () => redis.quit()],
});
