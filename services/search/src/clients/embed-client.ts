import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import {
  ExternalServiceError,
  PaymentRequiredError,
  ServiceUnavailableError,
} from '@onebox/errors';

export interface EmbedRequest {
  userId: string;
  texts: string[];
  // Searches are charged to the user; keeping the index current is not.
  charge: boolean;
}

export type EmbedClient = (request: EmbedRequest) => Promise<number[][]>;

// Embeddings come from llm-proxy, which holds the provider key and bills the user.
export function createEmbedClient(baseUrl: string, internalToken: string): EmbedClient {
  return async (request) => {
    const response = await fetch(new URL('/internal/embed', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: internalToken },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 402) {
      throw new PaymentRequiredError('You are out of AI credits', { code: 'OUT_OF_CREDITS' });
    }
    // No working provider key: jobs stop retrying until it is fixed and they are replayed.
    if (response.status === 503) {
      throw new ServiceUnavailableError('AI search is not set up', {
        code: 'EMBEDDINGS_OFF',
        retryable: false,
      });
    }
    if (!response.ok) throw new ExternalServiceError(`llm-proxy answered HTTP ${response.status}`);
    return ((await response.json()) as { vectors: number[][] }).vectors;
  };
}
