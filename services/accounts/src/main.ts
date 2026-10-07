import { createRemoteTokenVerifier, deriveInternalToken } from '@onebox/auth-kit';
import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createAccountService } from './accounts/account-service';
import { buildApp } from './app';
import { loadAccountsConfig } from './config';
import { migrateAccounts } from './db/migrate';
import { createImapVerifier } from './imap/verify-imap';

const logger = createLogger({ service: 'accounts', pretty: process.stdout.isTTY });
const config = loadAccountsConfig();
const pg = createPgClient(config.DATABASE_URL);

await pg.ping();
logger.info('database connected');
await migrateAccounts(pg, logger);

const accounts = createAccountService({
  db: pg.db,
  encryptionKey: config.CREDENTIALS_ENCRYPTION_KEY,
  verifyImap: createImapVerifier({ logger, allowPrivateHosts: config.ALLOW_PRIVATE_MAIL_HOSTS }),
  logger,
});
const verifyToken = createRemoteTokenVerifier(config.AUTH_SERVICE_URL);

const app = buildApp({
  logger,
  pingDatabase: pg.ping,
  routes: {
    accounts,
    verifyToken,
    internalToken: deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY),
  },
});
await startServer(app, { port: config.PORT, cleanups: [pg.close] });
