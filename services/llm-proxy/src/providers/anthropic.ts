import { keyAccepted, postJson, ProviderError, type ProviderAdapter } from './types';

interface MessagesResult {
  content?: { type: string; text?: string; input?: unknown }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// Anthropic Messages API. Structured output goes through a forced tool whose input is the schema.
export function anthropicAdapter(
  apiKey: string,
  baseUrl = 'https://api.anthropic.com/v1',
): ProviderAdapter {
  return {
    checkKey: () =>
      keyAccepted(`${baseUrl}/models?limit=1`, {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      }),

    async complete({ model, messages, schema, maxOutputTokens, temperature, timeoutMs }) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
      const body = {
        model,
        max_tokens: maxOutputTokens,
        ...(temperature !== undefined && { temperature }),
        ...(system.length && { system: system.join('\n\n') }),
        messages: messages
          .filter((m) => m.role !== 'system')
          .map(({ role, content }) => ({ role, content })),
        ...(schema && {
          tools: [
            { name: schema.name, description: 'Return the answer.', input_schema: schema.schema },
          ],
          tool_choice: { type: 'tool', name: schema.name },
        }),
      };
      const result = (await postJson(
        `${baseUrl}/messages`,
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body,
        timeoutMs,
      )) as MessagesResult;
      const blocks = result.content ?? [];
      const tool = blocks.find((block) => block.type === 'tool_use');
      const text = tool
        ? JSON.stringify(tool.input)
        : blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('');
      if (!text) throw new ProviderError('The model returned no text', 'EMPTY', true);
      // Anthropic counts cached input separately; fold it in so input means all input everywhere.
      const cacheReadTokens = result.usage?.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = result.usage?.cache_creation_input_tokens ?? 0;
      return {
        text,
        inputTokens: (result.usage?.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens,
        outputTokens: result.usage?.output_tokens ?? 0,
        cacheReadTokens,
        cacheWriteTokens,
      };
    },
  };
}
