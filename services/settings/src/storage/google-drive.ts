import { ExternalServiceError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { ExpiredGrantError, type StorageProvider } from './provider';

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

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
}

// The id token comes straight from Google's token endpoint over TLS, so its claims are trusted.
const emailFromIdToken = (idToken: string | undefined) => {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { email?: string };
  return claims.email ?? null;
};

// Google Drive through OAuth, with access only to files OneBox creates or the user picks.
export function googleDrive(
  { clientId, clientSecret, redirectUri }: GoogleOAuthConfig,
  logger: Logger,
  send: typeof fetch = fetch,
): StorageProvider {
  async function tokenRequest(params: Record<string, string>) {
    const response = await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    return { ok: response.ok, body: (await response.json()) as TokenResponse };
  }

  return {
    authUrl(state) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        // Always ask (and let them pick an account), so Google returns a refresh token.
        prompt: 'select_account consent',
        include_granted_scopes: 'true',
        state,
      });
      return `${AUTH_URL}?${params.toString()}`;
    },

    async exchange(code) {
      const { ok, body } = await tokenRequest({
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
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
      return {
        email,
        refreshToken: body.refresh_token,
        scopes,
        ...(body.access_token &&
          body.expires_in && { access: { token: body.access_token, expiresIn: body.expires_in } }),
      };
    },

    async refresh(refreshToken) {
      const { ok, body } = await tokenRequest({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      if (!ok || !body.access_token) {
        // Revoked at Google, or expired while the app was in testing.
        if (body.error === 'invalid_grant') throw new ExpiredGrantError();
        throw new ExternalServiceError('Google Drive is not responding');
      }
      return { token: body.access_token, expiresIn: body.expires_in ?? 3600 };
    },

    async revoke(refreshToken) {
      await send(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }),
      });
    },
  };
}
