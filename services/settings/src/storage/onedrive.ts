import { ExternalServiceError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { ExpiredGrantError, type StorageProvider } from './provider';

// "common" accepts both personal Microsoft accounts and work or school accounts.
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Files.ReadWrite'];

export interface MicrosoftOAuthConfig {
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

// The id token comes straight from Microsoft's token endpoint over TLS, so its claims are trusted.
const emailFromIdToken = (idToken: string | undefined) => {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    email?: string;
    preferred_username?: string;
  };
  return claims.email ?? claims.preferred_username ?? null;
};

// OneDrive through the Microsoft identity platform and Microsoft Graph.
export function oneDrive(
  { clientId, clientSecret, redirectUri }: MicrosoftOAuthConfig,
  logger: Logger,
  send: typeof fetch = fetch,
): StorageProvider {
  async function tokenRequest(params: Record<string, string>) {
    const response = await send(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: SCOPES.join(' '),
        ...params,
      }),
    });
    return { ok: response.ok, body: (await response.json()) as TokenResponse };
  }

  return {
    authUrl(state) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: SCOPES.join(' '),
        prompt: 'select_account',
        state,
      });
      return `${AUTHORITY}/authorize?${params.toString()}`;
    },

    async exchange(code) {
      const { ok, body } = await tokenRequest({
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });
      if (!ok || !body.refresh_token) {
        logger.warn({ error: body.error }, 'microsoft code exchange failed');
        throw new ExternalServiceError('Microsoft did not accept the sign-in. Please try again.');
      }
      const scopes = (body.scope ?? '').split(' ').filter(Boolean);
      if (!scopes.some((scope) => /(^|\/)Files\.ReadWrite$/i.test(scope))) {
        throw new ValidationError('Allow OneBox to save files to OneDrive, then try again.');
      }
      const email = emailFromIdToken(body.id_token);
      if (!email) throw new ExternalServiceError('Microsoft did not share the account address');
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
        if (body.error === 'invalid_grant') throw new ExpiredGrantError();
        throw new ExternalServiceError('OneDrive is not responding');
      }
      // Microsoft rotates refresh tokens, so the new one replaces the stored one.
      return {
        token: body.access_token,
        expiresIn: body.expires_in ?? 3600,
        ...(body.refresh_token && { refreshToken: body.refresh_token }),
      };
    },

    // Microsoft has no endpoint to revoke one app's token; forgetting it is what we can do, and
    // people remove the app at account.live.com/consent/Manage.
    async revoke() {},
  };
}
