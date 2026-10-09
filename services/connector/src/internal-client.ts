import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { ExternalServiceError } from '@onebox/errors';

export interface ActiveAccount {
  id: string;
  userId: string;
  provider: string;
  emailAddress: string;
  status: 'CONNECTED' | 'AUTH_FAILED' | 'UNREACHABLE' | 'TLS_ERROR';
  updatedAt: string;
  syncState: Record<string, unknown>;
}

export interface AccountCredentials {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  userId: string;
}

export type ReportedStatus = 'CONNECTED' | 'AUTH_FAILED' | 'UNREACHABLE' | 'TLS_ERROR';

export interface InternalClient {
  listAccounts(): Promise<ActiveAccount[]>;
  getCredentials(accountId: string): Promise<AccountCredentials>;
  saveSyncState(accountId: string, folder: string, state: object): Promise<void>;
  reportStatus(accountId: string, status: ReportedStatus, lastError: string | null): Promise<void>;
  getPreferences(userId: string): Promise<{ markSeenOnFetch: boolean }>;
}

export function createInternalClient({
  accountsUrl,
  settingsUrl,
  token,
}: {
  accountsUrl: string;
  settingsUrl: string;
  token: string;
}): InternalClient {
  async function call<T>(
    base: string,
    path: string,
    init: { method?: string; body?: object } = {},
  ) {
    const response = await fetch(new URL(path, base), {
      method: init.method ?? 'GET',
      headers: {
        [INTERNAL_TOKEN_HEADER]: token,
        ...(init.body && { 'content-type': 'application/json' }),
      },
      ...(init.body && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new ExternalServiceError(
        `${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}`,
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  return {
    listAccounts: async () =>
      (await call<{ items: ActiveAccount[] }>(accountsUrl, '/internal/accounts')).items,
    getCredentials: (accountId) =>
      call<AccountCredentials>(accountsUrl, `/internal/accounts/${accountId}/credentials`),
    saveSyncState: (accountId, folder, state) =>
      call<void>(accountsUrl, `/internal/accounts/${accountId}/sync-state`, {
        method: 'PUT',
        body: { folder, state },
      }),
    reportStatus: (accountId, status, lastError) =>
      call<void>(accountsUrl, `/internal/accounts/${accountId}/status`, {
        method: 'PUT',
        body: { status, lastError },
      }),
    getPreferences: (userId) =>
      call<{ markSeenOnFetch: boolean }>(settingsUrl, `/internal/preferences/${userId}`),
  };
}
