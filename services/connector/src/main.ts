import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { deriveInternalToken } from '@onebox/auth-kit';
import {
  historyPayloadSchema,
  mailboxOpPayloadSchema,
  QUEUES,
  type IngestPayload,
  type MailboxChangePayload,
} from '@onebox/contracts';
import { createServer, registerHealthRoutes, startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createMailboxStore } from '@onebox/mailbox-state';
import { createConsumer, createProducer, RETRY_POLICIES } from '@onebox/queue';
import { Redis } from 'ioredis';
import { loadConnectorConfig } from './config';
import { createHistoryHandler } from './history';
import { createInternalClient } from './internal-client';
import { createOpsHandler } from './ops';
import { createSupervisor } from './supervisor';

const logger = createLogger({ service: 'connector', pretty: process.stdout.isTTY });
const config = loadConnectorConfig();

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
const producer = createProducer<IngestPayload>(QUEUES.ingest, {
  redisUrl: config.REDIS_URL,
  logger,
});

const changes = createProducer<MailboxChangePayload>(QUEUES.mailboxChanges, {
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

// One at a time, so a quick star then unstar reach the server in that order.
const ops = createConsumer(
  QUEUES.mailboxOps,
  mailboxOpPayloadSchema,
  createOpsHandler({
    internal,
    changes,
    allowPrivateHosts: config.ALLOW_PRIVATE_MAIL_HOSTS,
    maxAttempts: RETRY_POLICIES[QUEUES.mailboxOps].attempts,
  }),
  { redisUrl: config.REDIS_URL, logger, concurrency: 1 },
);

const supervisor = createSupervisor({
  internal,
  redis,
  logger,
  ownerId: `${hostname()}:${randomUUID()}`,
  reconcileIntervalMs: config.RECONCILE_INTERVAL_MS,
  sessionDeps: {
    producer,
    changes,
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
  cleanups: [
    supervisor.close,
    history.close,
    ops.close,
    producer.close,
    changes.close,
    () => redis.quit(),
  ],
});
