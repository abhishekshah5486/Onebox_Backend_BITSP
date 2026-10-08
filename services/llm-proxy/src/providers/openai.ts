import { keyAccepted, postJson, ProviderError, type ProviderAdapter } from './types';

interface ResponsesResult {
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  status?: string;
}

// OpenAI Responses API, with native JSON-schema output when a schema is given.
export function openaiAdapter(
  apiKey: string,
  baseUrl = 'https://api.openai.com/v1',
): ProviderAdapter {
  return {
    checkKey: () => keyAccepted(`${baseUrl}/models`, { authorization: `Bearer ${apiKey}` }),

    async complete({ model, messages, schema, maxOutputTokens, temperature, timeoutMs }) {
      const body = {
        model,
        input: messages.map(({ role, content }) => ({
          role: role === 'system' ? 'developer' : role,
          content,
        })),
        max_output_tokens: maxOutputTokens,
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
      };
      const result = (await postJson(
        `${baseUrl}/responses`,
        { authorization: `Bearer ${apiKey}` },
        body,
        timeoutMs,
      )) as ResponsesResult;
      const text = (result.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '')
        .join('');
      if (!text) throw new ProviderError('The model returned no text', 'EMPTY', true);
      return {
        text,
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      };
    },
  };
}
