import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { ExternalServiceError, PaymentRequiredError } from '@onebox/errors';

export interface LlmRequest {
  userId: string;
  purpose: 'classify' | 'extract' | 'draft' | 'summarize';
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  schema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  subject?: string;
  traceId?: string;
}

export interface LlmResult {
  output: unknown;
  model: string;
}

export type LlmClient = (request: LlmRequest) => Promise<LlmResult>;

// Every model call goes through llm-proxy, which picks the model and handles fallback.
export function createLlmClient(baseUrl: string, internalToken: string): LlmClient {
  return async (request) => {
    const response = await fetch(new URL('/internal/complete', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: internalToken },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(180_000),
    });
    // Out of credits: retrying won't help until the user's credits change.
    if (response.status === 402) {
      throw new PaymentRequiredError('The user is out of AI credits', { code: 'OUT_OF_CREDITS' });
    }
    if (!response.ok) {
      throw new ExternalServiceError(`llm-proxy answered HTTP ${response.status}`);
    }
    return (await response.json()) as LlmResult;
  };
}
