import { createRemoteTokenVerifier, deriveInternalToken } from '@onebox/auth-kit';
import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { buildApp } from './app';
import { loadSettingsConfig } from './config';
import { migrateSettings } from './db/migrate';
import { googleDrive } from './storage/google-drive';
import { oneDrive } from './storage/onedrive';
import { createStorageService } from './storage/storage-service';
import { createIntegrationService } from './integrations/integration-service';
import { createPreferencesService } from './preferences/preferences-service';

const logger = createLogger({ service: 'settings', pretty: process.stdout.isTTY });
const config = loadSettingsConfig();
const pg = createPgClient(config.DATABASE_URL);

await pg.ping();
logger.info('database connected');
await migrateSettings(pg, logger);

const app = buildApp({
  logger,
  pingDatabase: pg.ping,
  routes: {
    preferences: createPreferencesService({ db: pg.db, logger }),
    integrations: createIntegrationService({
      db: pg.db,
      encryptionKey: config.CREDENTIALS_ENCRYPTION_KEY,
      logger,
      allowPrivateHosts: config.ALLOW_PRIVATE_WEBHOOK_HOSTS,
    }),
    storage: createStorageService({
      db: pg.db,
      encryptionKey: config.CREDENTIALS_ENCRYPTION_KEY,
      logger,
      providers: {
        ...(config.GOOGLE_CLIENT_ID &&
          config.GOOGLE_CLIENT_SECRET && {
            GOOGLE_DRIVE: googleDrive(
              {
                clientId: config.GOOGLE_CLIENT_ID,
                clientSecret: config.GOOGLE_CLIENT_SECRET,
                redirectUri: config.GOOGLE_REDIRECT_URI,
              },
              logger,
            ),
          }),
        ...(config.MICROSOFT_CLIENT_ID &&
          config.MICROSOFT_CLIENT_SECRET && {
            ONEDRIVE: oneDrive(
              {
                clientId: config.MICROSOFT_CLIENT_ID,
                clientSecret: config.MICROSOFT_CLIENT_SECRET,
                redirectUri: config.MICROSOFT_REDIRECT_URI,
              },
              logger,
            ),
          }),
      },
    }),
    verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
    internalToken: deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY),
  },
});
await startServer(app, { port: config.PORT, cleanups: [pg.close] });
