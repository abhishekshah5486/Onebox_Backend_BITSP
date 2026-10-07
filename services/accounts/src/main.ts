import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { buildApp } from './app';
import { loadAccountsConfig } from './config';
import { migrateAccounts } from './db/migrate';

const logger = createLogger({ service: 'accounts', pretty: process.stdout.isTTY });
const config = loadAccountsConfig();
const pg = createPgClient(config.DATABASE_URL);

await pg.ping();
logger.info('database connected');
await migrateAccounts(pg, logger);

const app = buildApp({ logger, pingDatabase: pg.ping });
await startServer(app, { port: config.PORT, cleanups: [pg.close] });
