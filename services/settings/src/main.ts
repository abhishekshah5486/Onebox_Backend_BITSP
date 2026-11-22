import {
  createRemoteTokenVerifier,
  deriveInternalToken,
  INTERNAL_TOKEN_HEADER,
} from '@onebox/auth-kit';
import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { buildApp } from './app';
import { loadSettingsConfig } from './config';
import { migrateSettings } from './db/migrate';
import { dropbox } from './storage/dropbox';
import { googleDrive } from './storage/google-drive';
import { oneDrive } from './storage/onedrive';
import { createStorageService } from './storage/storage-service';
import { createIndexingStorage } from './indexing/indexing-storage';
import { createIntegrationService } from './integrations/integration-service';
import { createPreferencesService } from './preferences/preferences-service';

const logger = createLogger({ service: 'settings', pretty: process.stdout.isTTY });
const config = loadSettingsConfig();
const pg = createPgClient(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });

await pg.ping();
logger.info('database connected');
await migrateSettings(pg, logger);

const internalToken = deriveInternalToken(config.CREDENTIALS_ENCRYPTION_KEY);

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
      allowPrivateHosts: config.ALLOW_PRIVATE_STORAGE_HOSTS,
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
        ...(config.DROPBOX_APP_KEY &&
          config.DROPBOX_APP_SECRET && {
            DROPBOX: dropbox(
              {
                appKey: config.DROPBOX_APP_KEY,
                appSecret: config.DROPBOX_APP_SECRET,
                redirectUri: config.DROPBOX_REDIRECT_URI,
              },
              logger,
            ),
          }),
      },
    }),
    indexing: createIndexingStorage({
      db: pg.db,
      encryptionKey: config.CREDENTIALS_ENCRYPTION_KEY,
      logger,
      allowPrivateHosts: config.ALLOW_PRIVATE_STORAGE_HOSTS,
      notifySearch: async (userId) => {
        const response = await fetch(`${config.SEARCH_SERVICE_URL}/internal/semantic/rebuild`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: internalToken },
          body: JSON.stringify({ userId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`search answered ${response.status}`);
      },
    }),
    verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
    internalToken,
  },
});
await startServer(app, { port: config.PORT, cleanups: [pg.close] });
