import { createRemoteTokenVerifier, deriveInternalToken } from '@onebox/auth-kit';
import { paymentEventPayloadSchema, QUEUES, usageEventPayloadSchema } from '@onebox/contracts';
import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createConsumer } from '@onebox/queue';
import { buildApp } from './app';
import { loadBillingConfig } from './config';
import { createCredits } from './credits/credits';
import { migrateBilling } from './db/migrate';

const REFILL_EVERY_MS = 10 * 60_000;

const logger = createLogger({ service: 'billing', pretty: process.stdout.isTTY });
const config = loadBillingConfig();
const pg = createPgClient(config.DATABASE_URL);

await pg.ping();
logger.info('database connected');
await migrateBilling(pg, logger);

const credits = createCredits({ db: pg.db, creditsPerUsd: config.CREDITS_PER_USD, logger });

// Payments start, renew, change and end plans; llm-proxy reports each paid model call.
const payments = createConsumer(
  QUEUES.payments,
  paymentEventPayloadSchema,
  (envelope) => credits.applyPayment(envelope.jobId, envelope.userId, envelope.payload),
  { redisUrl: config.REDIS_URL, logger, concurrency: 2 },
);
const usage = createConsumer(
  QUEUES.usage,
  usageEventPayloadSchema,
  (envelope) => credits.charge(envelope.userId, envelope.payload),
  { redisUrl: config.REDIS_URL, logger },
);

const refill = () =>
  void credits.refillDue().catch((err: unknown) => logger.error({ err }, 'refill failed'));
refill();
const refills = setInterval(refill, REFILL_EVERY_MS);
refills.unref();

const app = buildApp({
  logger,
  pingDatabase: pg.ping,
  routes: {
    credits,
    verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
    internalToken: deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY),
  },
});
await startServer(app, {
  port: config.PORT,
  cleanups: [async () => clearInterval(refills), payments.close, usage.close, pg.close],
});
