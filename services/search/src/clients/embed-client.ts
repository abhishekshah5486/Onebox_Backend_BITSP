import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import {
  ExternalServiceError,
  PaymentRequiredError,
  ServiceUnavailableError,
} from '@onebox/errors';
import pRetry from 'p-retry';

export interface EmbedRequest {
  userId: string;
  texts: string[];
  // Searches are charged to the user; keeping the index current is not.
  charge: boolean;
  // Defaults to the user's own pick.
  model?: string;
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

export interface EmbedModel {
  id: string;
  name: string;
  dimensions: number;
  local: boolean;
}

// The model a user embeds with (the server default without one), waiting for llm-proxy if it is
// still starting.
export function fetchEmbedModel(
  baseUrl: string,
  internalToken: string,
  {
    userId,
    retries = 30,
    onRetry,
  }: { userId?: string; retries?: number; onRetry?: (error: Error) => void } = {},
): Promise<EmbedModel> {
  const url = new URL('/internal/embed/model', baseUrl);
  if (userId) url.searchParams.set('userId', userId);
  return pRetry(
    async () => {
      const response = await fetch(url, {
        headers: { [INTERNAL_TOKEN_HEADER]: internalToken },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        throw new ExternalServiceError(`llm-proxy answered HTTP ${response.status}`);
      return (await response.json()) as EmbedModel;
    },
    {
      retries,
      minTimeout: 1_000,
      maxTimeout: 5_000,
      onFailedAttempt: ({ error }) => onRetry?.(error),
    },
  );
}

// e.g. mail_ollama_bge_m3_1024: vectors from different models never share a collection.
export const collectionFor = (model: EmbedModel) =>
  `mail_${model.id.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${model.dimensions}`;
