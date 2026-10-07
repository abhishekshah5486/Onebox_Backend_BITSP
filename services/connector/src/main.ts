import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { deriveInternalToken } from '@onebox/auth-kit';
import { historyPayloadSchema, QUEUES, type IngestPayload } from '@onebox/contracts';
import { createServer, registerHealthRoutes, startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createMailboxStore } from '@onebox/mailbox-state';
import { createConsumer, createProducer } from '@onebox/queue';
import { Redis } from 'ioredis';
import { loadConnectorConfig } from './config';
import { createHistoryHandler } from './history';
import { createInternalClient } from './internal-client';
import { createSupervisor } from './supervisor';

const logger = createLogger({ service: 'connector', pretty: process.stdout.isTTY });
const config = loadConnectorConfig();

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
const producer = createProducer<IngestPayload>(QUEUES.ingest, {
  redisUrl: config.REDIS_URL,
  logger,
});

const store = createMailboxStore(redis);
const internal = createInternalClient({
  accountsUrl: config.ACCOUNTS_SERVICE_URL,
  settingsUrl: config.SETTINGS_SERVICE_URL,
  token: deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY),
});

const history = createConsumer(
  QUEUES.history,
  historyPayloadSchema,
  createHistoryHandler({
    internal,
    store,
    producer,
    allowPrivateHosts: config.ALLOW_PRIVATE_MAIL_HOSTS,
  }),
  { redisUrl: config.REDIS_URL, logger, concurrency: 4 },
);

const supervisor = createSupervisor({
  internal,
  redis,
  logger,
  ownerId: `${hostname()}:${randomUUID()}`,
  reconcileIntervalMs: config.RECONCILE_INTERVAL_MS,
  sessionDeps: {
    producer,
    store,
    allowPrivateHosts: config.ALLOW_PRIVATE_MAIL_HOSTS,
    initialBatch: config.INITIAL_BATCH,
    highWatermark: config.INGEST_HIGH_WATERMARK,
  },
});

const app = createServer({ logger });
registerHealthRoutes(app, { redis: () => redis.ping() });
app.get('/status', async () => ({ connected: supervisor.running().length }));

supervisor.start();
await startServer(app, {
  port: config.PORT,
  cleanups: [supervisor.close, history.close, producer.close, () => redis.quit()],
});
