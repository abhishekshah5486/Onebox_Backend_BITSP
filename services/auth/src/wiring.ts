import { createTokenVerifier } from '@onebox/auth-kit';
import type { PgClient } from '@onebox/db-pg';
import type { Logger } from '@onebox/logger';
import { createLocalJWKSet } from 'jose';
import { createKeyStore } from './keys/key-store';
import type { AuthRouteDeps } from './routes';
import { createRefreshTokens } from './tokens/refresh-tokens';
import { createUserService } from './users/user-service';

export function createAuthDeps(pg: PgClient, encryptionKey: Buffer, logger: Logger): AuthRouteDeps {
  const keyStore = createKeyStore({ db: pg.db, encryptionKey, logger });
  const refreshTokens = createRefreshTokens(pg.db, logger);
  const users = createUserService({ db: pg.db, keyStore, refreshTokens, logger });
  const verifyToken = createTokenVerifier(async (header, token) =>
    createLocalJWKSet(await keyStore.getPublicJwks())(header, token),
  );
  return { users, keyStore, verifyToken };
}
