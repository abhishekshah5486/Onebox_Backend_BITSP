import { ExternalServiceError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { ACCESS_DENIED, ExpiredGrantError, type StorageProvider } from './provider';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.metadata.write',
  'files.content.write',
];

export interface DropboxOAuthConfig {
  appKey: string;
  appSecret: string;
  redirectUri: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

// Dropbox through its OAuth 2 code flow with offline (refresh) tokens.
export function dropbox(
  { appKey, appSecret, redirectUri }: DropboxOAuthConfig,
  logger: Logger,
  send: typeof fetch = fetch,
): StorageProvider {
  async function tokenRequest(params: Record<string, string>) {
    const response = await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: appKey, client_secret: appSecret, ...params }),
    });
    return { ok: response.ok, body: (await response.json()) as TokenResponse };
  }

  async function refresh(refreshToken: string) {
    const { ok, body } = await tokenRequest({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (!ok || !body.access_token) {
      if (body.error === 'invalid_grant') throw new ExpiredGrantError();
      throw new ExternalServiceError('Dropbox is not responding');
    }
    return { token: body.access_token, expiresIn: body.expires_in ?? 14_400 };
  }

  // A route without arguments takes no body and no content type.
  const call = (token: string, route: string) =>
    send(`${API}/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

  return {
    authUrl(state) {
      const params = new URLSearchParams({
        client_id: appKey,
        redirect_uri: redirectUri,
        response_type: 'code',
        token_access_type: 'offline',
        scope: SCOPES.join(' '),
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
      if (!ok || !body.refresh_token || !body.access_token) {
        logger.warn({ error: body.error }, 'dropbox code exchange failed');
        throw new ExternalServiceError('Dropbox did not accept the sign-in. Please try again.');
      }
      const scopes = (body.scope ?? '').split(' ').filter(Boolean);
      if (!scopes.includes('files.content.write')) {
        throw new ValidationError('Allow OneBox to save files to Dropbox, then try again.', {
          code: ACCESS_DENIED,
        });
      }
      const account = await call(body.access_token, 'users/get_current_account');
      const email = account.ok ? ((await account.json()) as { email?: string }).email : undefined;
      if (!email) throw new ExternalServiceError('Dropbox did not share the account address');
      return {
        email,
        refreshToken: body.refresh_token,
        scopes,
        access: { token: body.access_token, expiresIn: body.expires_in ?? 14_400 },
      };
    },

    refresh,

    // Revoking needs an access token, so get a fresh one first.
    async revoke(refreshToken) {
      const { token } = await refresh(refreshToken);
      await call(token, 'auth/token/revoke');
    },
  };
}
