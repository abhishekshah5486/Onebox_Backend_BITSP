import { ExternalServiceError } from '@onebox/errors';

export type ThreadLookup = (authorization: string, threadIds: string[]) => Promise<unknown[]>;

// Results are shown as conversations, so they come from mail with the caller's own token.
export function createThreadLookup(baseUrl: string): ThreadLookup {
  return async (authorization, threadIds) => {
    if (threadIds.length === 0) return [];
    const response = await fetch(new URL('/mail/threads/lookup', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ threadIds }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ExternalServiceError(`mail answered HTTP ${response.status}`);
    return ((await response.json()) as { items: unknown[] }).items;
  };
}
