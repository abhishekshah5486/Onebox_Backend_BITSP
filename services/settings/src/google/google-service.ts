import { decrypt, encrypt } from '@onebox/crypto';
import {
  ExternalServiceError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { googleConnections } from '../db/schema';
import { createStateSigner } from './state';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = ['openid', 'email', DRIVE_SCOPE];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleServiceDeps {
  db: PostgresJsDatabase;
  encryptionKey: Buffer;
  logger: Logger;
  oauth: GoogleOAuthConfig | null;
  fetch?: typeof fetch;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

const aadFor = (userId: string) => `google:${userId}`;

// The id token comes straight from Google's token endpoint over TLS, so its claims are trusted.
const emailFromIdToken = (idToken: string | undefined) => {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { email?: string };
  return claims.email ?? null;
};

export function createGoogleService({
  db,
  encryptionKey,
  logger,
  oauth,
  fetch: send = fetch,
}: GoogleServiceDeps) {
  const state = createStateSigner(encryptionKey);
  const accessTokens = new Map<string, { token: string; expiresAt: number }>();

  const configured = () => {
    if (!oauth) throw new ServiceUnavailableError('Google sign-in is not configured');
    return oauth;
  };

  async function tokenRequest(params: Record<string, string>) {
    const { clientId, clientSecret } = configured();
    const response = await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    return { ok: response.ok, body: (await response.json()) as TokenResponse };
  }

  const connection = (userId: string) =>
    db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.userId, userId))
      .then((rows) => rows[0]);

  return {
    authUrl(userId: string) {
      const { clientId, redirectUri } = configured();
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        // Always ask, so Google returns a refresh token even on a reconnect.
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: state.sign(userId),
      });
      return `${AUTH_URL}?${params.toString()}`;
    },

    // Finishes the flow started by authUrl and returns the connected address.
    async complete(code: string, signedState: string) {
      const userId = state.verify(signedState);
      if (!userId) throw new ValidationError('This sign-in link has expired. Please try again.');
      const { ok, body } = await tokenRequest({
        code,
        grant_type: 'authorization_code',
        redirect_uri: configured().redirectUri,
      });
      if (!ok || !body.refresh_token) {
        logger.warn({ error: body.error }, 'google code exchange failed');
        throw new ExternalServiceError('Google did not accept the sign-in. Please try again.');
      }
      const scopes = (body.scope ?? '').split(' ').filter(Boolean);
      if (!scopes.includes(DRIVE_SCOPE)) {
        throw new ValidationError('Allow OneBox to see the Drive files it uses, then try again.');
      }
      const email = emailFromIdToken(body.id_token) ?? 'Google account';
      const values = {
        email,
        refreshTokenEncrypted: encrypt(body.refresh_token, encryptionKey, aadFor(userId)),
        scopes,
      };
      await db
        .insert(googleConnections)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: googleConnections.userId, set: values });
      if (body.access_token && body.expires_in) {
        accessTokens.set(userId, {
          token: body.access_token,
          expiresAt: Date.now() + body.expires_in * 1000,
        });
      } else {
        accessTokens.delete(userId);
      }
      logger.info({ userId }, 'google drive connected');
      return email;
    },

    async status(userId: string) {
      const row = await connection(userId);
      return {
        configured: oauth !== null,
        connected: Boolean(row),
        email: row?.email ?? null,
        connectedAt: row?.updatedAt.toISOString() ?? null,
      };
    },

    async disconnect(userId: string) {
      const row = await connection(userId);
      if (!row) return;
      await db.delete(googleConnections).where(eq(googleConnections.userId, userId));
      accessTokens.delete(userId);
      const token = decrypt(row.refreshTokenEncrypted, encryptionKey, aadFor(userId));
      await send(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      }).catch((err: unknown) => logger.warn({ err }, 'google token revoke failed'));
      logger.info({ userId }, 'google drive disconnected');
    },

    // A short-lived access token for Drive calls made by other services.
    async accessToken(userId: string) {
      const cached = accessTokens.get(userId);
      if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
      const row = await connection(userId);
      if (!row) throw new NotFoundError('Google Drive is not connected');
      const { ok, body } = await tokenRequest({
        refresh_token: decrypt(row.refreshTokenEncrypted, encryptionKey, aadFor(userId)),
        grant_type: 'refresh_token',
      });
      if (!ok || !body.access_token) {
        if (body.error === 'invalid_grant') {
          // Revoked, or expired (test-mode apps lose refresh tokens after 7 days).
          await db.delete(googleConnections).where(eq(googleConnections.userId, userId));
          throw new NotFoundError('Google Drive access has expired. Please connect it again.');
        }
        throw new ExternalServiceError('Google Drive is not responding');
      }
      accessTokens.set(userId, {
        token: body.access_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      });
      return body.access_token;
    },
  };
}

export type GoogleService = ReturnType<typeof createGoogleService>;
