import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { ExternalServiceError, NotFoundError } from '@onebox/errors';

export interface SenderAccount {
  id: string;
  userId: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
}

export type AccountsClient = (accountId: string) => Promise<SenderAccount>;

// Looks an account up in the accounts service, to check who owns it before sending from it.
export function createAccountsClient(baseUrl: string, internalToken: string): AccountsClient {
  return async (accountId) => {
    const response = await fetch(new URL(`/internal/accounts/${accountId}`, baseUrl), {
      headers: { [INTERNAL_TOKEN_HEADER]: internalToken },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) throw new NotFoundError('That account was not found');
    if (!response.ok) {
      throw new ExternalServiceError(`accounts answered HTTP ${response.status}`);
    }
    return (await response.json()) as SenderAccount;
  };
}
