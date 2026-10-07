import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { deriveInternalToken } from '@onebox/auth-kit';
import { QUEUES, type IngestPayload } from '@onebox/contracts';
import { createServer, registerHealthRoutes, startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createProducer } from '@onebox/queue';
import { Redis } from 'ioredis';
import { loadConnectorConfig } from './config';
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

const supervisor = createSupervisor({
  internal: createInternalClient({
    accountsUrl: config.ACCOUNTS_SERVICE_URL,
    settingsUrl: config.SETTINGS_SERVICE_URL,
    token: deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY),
  }),
  redis,
  logger,
  ownerId: `${hostname()}:${randomUUID()}`,
  reconcileIntervalMs: config.RECONCILE_INTERVAL_MS,
  sessionDeps: {
    producer,
    allowPrivateHosts: config.ALLOW_PRIVATE_MAIL_HOSTS,
    backfillDays: config.BACKFILL_DAYS,
    highWatermark: config.INGEST_HIGH_WATERMARK,
  },
});

const app = createServer({ logger });
registerHealthRoutes(app, { redis: () => redis.ping() });
app.get('/status', async () => ({ connected: supervisor.running().length }));

supervisor.start();
await startServer(app, {
  port: config.PORT,
  cleanups: [supervisor.close, producer.close, () => redis.quit()],
});
