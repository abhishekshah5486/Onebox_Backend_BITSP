import { decrypt, encrypt } from '@onebox/crypto';
import {
  ExternalServiceError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { and, asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { googleConnections, type GoogleConnectionRow } from '../db/schema';
import { createStateSigner } from './state';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = ['openid', 'email', DRIVE_SCOPE];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const MAX_ACCOUNTS = 10;

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

  const ownConnection = (userId: string, id: string) =>
    db
      .select()
      .from(googleConnections)
      .where(and(eq(googleConnections.id, id), eq(googleConnections.userId, userId)))
      .then((rows) => {
        if (!rows[0]) throw new NotFoundError('That Google account is not connected');
        return rows[0];
      });

  const view = (row: GoogleConnectionRow) => ({
    id: row.id,
    email: row.email,
    defaultPath: row.defaultPath,
    connectedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  return {
    authUrl(userId: string) {
      const { clientId, redirectUri } = configured();
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        // Always ask (and let them pick an account), so Google returns a refresh token.
        prompt: 'select_account consent',
        include_granted_scopes: 'true',
        state: state.sign(userId),
      });
      return `${AUTH_URL}?${params.toString()}`;
    },

    // Finishes the flow started by authUrl and returns the connected address. Connecting the
    // same Google account again refreshes its token and keeps its folder.
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
      const email = emailFromIdToken(body.id_token);
      if (!email) throw new ExternalServiceError('Google did not share the account address');
      const count = await db.$count(googleConnections, eq(googleConnections.userId, userId));
      const existing = await db
        .select({ id: googleConnections.id })
        .from(googleConnections)
        .where(and(eq(googleConnections.userId, userId), eq(googleConnections.email, email)));
      if (!existing[0] && count >= MAX_ACCOUNTS) {
        throw new ValidationError(`You can connect up to ${MAX_ACCOUNTS} Google accounts.`);
      }
      const values = {
        refreshTokenEncrypted: encrypt(body.refresh_token, encryptionKey, aadFor(userId)),
        scopes,
      };
      const [row] = await db
        .insert(googleConnections)
        .values({ userId, email, ...values })
        .onConflictDoUpdate({
          target: [googleConnections.userId, googleConnections.email],
          set: values,
        })
        .returning({ id: googleConnections.id });
      if (row && body.access_token && body.expires_in) {
        accessTokens.set(row.id, {
          token: body.access_token,
          expiresAt: Date.now() + body.expires_in * 1000,
        });
      }
      logger.info({ userId }, 'google drive connected');
      return email;
    },

    async list(userId: string) {
      const rows = await db
        .select()
        .from(googleConnections)
        .where(eq(googleConnections.userId, userId))
        .orderBy(asc(googleConnections.createdAt));
      return { configured: oauth !== null, accounts: rows.map(view) };
    },

    async setDefaultPath(userId: string, id: string, defaultPath: string) {
      await ownConnection(userId, id);
      const [row] = await db
        .update(googleConnections)
        .set({ defaultPath })
        .where(eq(googleConnections.id, id))
        .returning();
      return view(row!);
    },

    async disconnect(userId: string, id: string) {
      const row = await ownConnection(userId, id);
      await db.delete(googleConnections).where(eq(googleConnections.id, id));
      accessTokens.delete(id);
      const token = decrypt(row.refreshTokenEncrypted, encryptionKey, aadFor(userId));
      await send(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      }).catch((err: unknown) => logger.warn({ err }, 'google token revoke failed'));
      logger.info({ userId }, 'google drive disconnected');
    },

    // A short-lived access token for Drive calls made by other services.
    async accessToken(userId: string, id: string) {
      const row = await ownConnection(userId, id);
      const cached = accessTokens.get(id);
      if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
      const { ok, body } = await tokenRequest({
        refresh_token: decrypt(row.refreshTokenEncrypted, encryptionKey, aadFor(userId)),
        grant_type: 'refresh_token',
      });
      if (!ok || !body.access_token) {
        if (body.error === 'invalid_grant') {
          // Revoked at Google, or expired while the app was in testing.
          await db.delete(googleConnections).where(eq(googleConnections.id, id));
          throw new NotFoundError(
            `Google Drive access for ${row.email} has expired. Please connect it again.`,
          );
        }
        throw new ExternalServiceError('Google Drive is not responding');
      }
      accessTokens.set(id, {
        token: body.access_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      });
      return body.access_token;
    },
  };
}

export type GoogleService = ReturnType<typeof createGoogleService>;
