import { keyAccepted, postJson, ProviderError, type ProviderAdapter } from './types';

interface GenerateResult {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

// Gemini generateContent, asking for JSON that matches the schema when one is given.
export function geminiAdapter(
  apiKey: string,
  baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
): ProviderAdapter {
  return {
    checkKey: () => keyAccepted(`${baseUrl}/models?pageSize=1`, { 'x-goog-api-key': apiKey }),

    async complete({ model, messages, schema, maxOutputTokens, temperature, timeoutMs }) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
      const body = {
        ...(system.length && { systemInstruction: { parts: [{ text: system.join('\n\n') }] } }),
        contents: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
        generationConfig: {
          maxOutputTokens,
          ...(temperature !== undefined && { temperature }),
          ...(schema && {
            responseMimeType: 'application/json',
            responseJsonSchema: schema.schema,
          }),
        },
      };
      const result = (await postJson(
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        body,
        timeoutMs,
      )) as GenerateResult;
      if (result.promptFeedback?.blockReason) {
        throw new ProviderError(`Blocked: ${result.promptFeedback.blockReason}`, 'BLOCKED', false);
      }
      const text = (result.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) throw new ProviderError('The model returned no text', 'EMPTY', true);
      return {
        text,
        inputTokens: result.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: result.usageMetadata?.candidatesTokenCount ?? 0,
      };
    },
  };
}
