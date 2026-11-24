import { APICallError, type LanguageModelV4 } from '@ai-sdk/provider';
import { generateText } from 'ai';
import { ProviderError, type ProviderAdapter } from '../providers/types';

// Same failure kinds the built-in adapters report, so retries and the breaker treat them alike.
function toProviderError(err: unknown): ProviderError {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    const code =
      status === 429
        ? 'RATE_LIMITED'
        : status === 401 || status === 403
          ? 'AUTH'
          : status === 404
            ? 'MODEL_NOT_FOUND'
            : status !== undefined && status >= 500
              ? 'PROVIDER_DOWN'
              : 'BAD_REQUEST';
    return new ProviderError(
      `HTTP ${status ?? '?'}: ${(err.responseBody ?? err.message).slice(0, 300)}`,
      code,
      err.isRetryable,
      status,
    );
  }
  const error = err as Error;
  const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
  return new ProviderError(error.message, timeout ? 'TIMEOUT' : 'NETWORK', true);
}

// A user's own model behind the same interface as OneBox's providers. JSON answers are asked
// for in the prompt, since not every provider supports structured output.
export function sdkAdapter(model: LanguageModelV4): ProviderAdapter {
  return {
    async complete(request) {
      const system = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content);
      if (request.schema) {
        system.push(
          `Reply with only JSON matching this JSON schema, no other text:\n${JSON.stringify(request.schema.schema)}`,
        );
      }
      try {
        const result = await generateText({
          model,
          system: system.join('\n\n') || undefined,
          messages: request.messages
            .filter((message) => message.role !== 'system')
            .map((message) => ({
              role: message.role as 'user' | 'assistant',
              content: message.content,
            })),
          maxOutputTokens: request.maxOutputTokens,
          ...(request.temperature !== undefined && { temperature: request.temperature }),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(request.timeoutMs),
        });
        return {
          text: result.text,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWriteTokens: result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          // The user pays their provider directly.
          costUsd: 0,
        };
      } catch (err) {
        throw toProviderError(err);
      }
    },
    checkKey: async () => true,
  };
}
