import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { buildApp } from './app';
import { loadPaymentsConfig, razorpayKeys } from './config';
import { migratePayments } from './db/migrate';

const logger = createLogger({ service: 'payments', pretty: process.stdout.isTTY });
const config = loadPaymentsConfig();
const pg = createPgClient(config.DATABASE_URL);

await pg.ping();
logger.info('database connected');
await migratePayments(pg, logger);
logger.info(
  { mode: config.RAZORPAY_MODE, razorpay: razorpayKeys(config) !== null },
  'payment providers configured',
);

const app = buildApp({ logger, pingDatabase: pg.ping });
await startServer(app, { port: config.PORT, cleanups: [pg.close] });
