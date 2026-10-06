import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { buildApp } from './app';
import { loadAuthConfig } from './config';
import { migrateIdentity } from './db/migrate';

const logger = createLogger({ service: 'auth', pretty: process.stdout.isTTY });
const config = loadAuthConfig();
const pg = createPgClient(config.DATABASE_URL);

await pg.ping();
logger.info('database connected');
await migrateIdentity(pg, logger);

const app = buildApp({ logger, pingDatabase: pg.ping });
await startServer(app, { port: config.AUTH_PORT, cleanups: [pg.close] });
