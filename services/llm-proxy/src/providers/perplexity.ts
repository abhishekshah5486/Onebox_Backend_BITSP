import { keyAccepted, postJson, ProviderError, type ProviderAdapter } from './types';

// Reasoning models spend output tokens thinking before they answer; too small a budget ends the
// reply with no answer at all. Only tokens actually produced are billed.
const MIN_OUTPUT_TOKENS = 4096;

interface AgentResult {
  status?: string;
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
    cost?: { total_cost?: number };
  };
}

// Perplexity's Agent API: models from makers OneBox has no key for (Grok, Kimi, GLM, DeepSeek,
// Nemotron), in the Responses format. Each reply says what it cost, which is recorded as it is.
export function perplexityAdapter(
  apiKey: string,
  baseUrl = 'https://api.perplexity.ai',
): ProviderAdapter {
  const auth = { authorization: `Bearer ${apiKey}` };
  return {
    checkKey: () => keyAccepted(`${baseUrl}/v1/models`, auth),

    async complete({ model, messages, schema, maxOutputTokens, temperature, timeoutMs }) {
      const result = (await postJson(
        `${baseUrl}/v1/agent`,
        auth,
        {
          model,
          input: messages.map(({ role, content }) => ({ role, content })),
          max_output_tokens: Math.max(maxOutputTokens, MIN_OUTPUT_TOKENS),
          ...(temperature !== undefined && { temperature }),
          ...(schema && {
            text: {
              format: {
                type: 'json_schema',
                name: schema.name,
                schema: schema.schema,
                strict: false,
              },
            },
          }),
        },
        timeoutMs,
      )) as AgentResult;
      const text = (result.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '')
        .join('');
      if (!text && result.status === 'incomplete') {
        // Asking again would end the same way; the next model is tried instead.
        throw new ProviderError('The model ran out of output tokens', 'TRUNCATED', false);
      }
      if (!text) throw new ProviderError('The model returned no text', 'EMPTY', true);
      return {
        text,
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
        cacheReadTokens: result.usage?.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: result.usage?.input_tokens_details?.cache_creation_input_tokens ?? 0,
        costUsd: result.usage?.cost?.total_cost,
      };
    },
  };
}
