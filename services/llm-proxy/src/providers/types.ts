export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  // When set, the answer must be JSON matching this schema.
  schema?: { name: string; schema: Record<string, unknown> } | undefined;
  maxOutputTokens: number;
  temperature?: number | undefined;
  timeoutMs: number;
}

export interface ProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderAdapter {
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  // False when the provider rejects the key; network trouble counts as usable.
  checkKey(): Promise<boolean>;
}

export async function keyAccepted(url: string, headers: Record<string, string>) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    return response.status !== 401 && response.status !== 403;
  } catch {
    return true;
  }
}

// Retryable: rate limits, outages and timeouts. Anything else (a bad key, a bad request) is not.
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError';
    throw new ProviderError(
      timeout ? `No answer within ${timeoutMs}ms` : (err as Error).message,
      timeout ? 'TIMEOUT' : 'NETWORK',
      true,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    const code =
      response.status === 429
        ? 'RATE_LIMITED'
        : response.status === 401 || response.status === 403
          ? 'AUTH'
          : response.status === 404
            ? 'MODEL_NOT_FOUND'
            : response.status >= 500
              ? 'PROVIDER_DOWN'
              : 'BAD_REQUEST';
    // Provider error bodies describe the request, never contain our secrets.
    throw new ProviderError(
      `HTTP ${response.status}: ${text.slice(0, 300)}`,
      code,
      retryable,
      response.status,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError('The provider sent something that is not JSON', 'BAD_RESPONSE', true);
  }
}
