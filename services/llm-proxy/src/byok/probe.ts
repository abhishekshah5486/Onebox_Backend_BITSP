import { ValidationError } from '@onebox/errors';
import { APICallError } from '@ai-sdk/provider';
import { embed, generateText } from 'ai';
import type { ModelKind } from '../db/schema';
import type { DirectoryProvider } from './directory';
import { checkEgress } from './egress';
import { sdkFor, type SdkProvider, type Settings } from './sdks';

// Names like a region or an Azure resource end up inside URLs, so they stay plain.
const PLAIN = /^[\w.-]{1,100}$/;
const FREE_TEXT = new Set(['apiKey', 'secretAccessKey', 'credentials', 'baseURL']);

// Only the provider's own fields, the required ones filled in, each in a sensible shape.
export async function checkSettings(
  provider: DirectoryProvider,
  settings: Settings,
  allowPrivate: boolean,
): Promise<Settings> {
  const clean: Settings = {};
  for (const field of provider.fields) {
    const value = settings[field.key]?.trim() || field.default;
    if (!value) {
      if (field.required) throw new ValidationError(`${field.label} is required`);
      continue;
    }
    if (value.length > 20_000) throw new ValidationError(`${field.label} is too long`);
    if (!FREE_TEXT.has(field.key) && !PLAIN.test(value)) {
      throw new ValidationError(`${field.label} may only have letters, digits, dots and dashes`);
    }
    if (field.key === 'credentials') {
      try {
        JSON.parse(value);
      } catch {
        throw new ValidationError(`${field.label} must be the JSON file's contents`);
      }
    }
    clean[field.key] = value;
  }
  if (clean.baseURL) await checkEgress(clean.baseURL, allowPrivate);
  return clean;
}

export function connect(provider: DirectoryProvider, settings: Settings): SdkProvider {
  const sdk = sdkFor(provider.npm);
  if (!sdk) throw new ValidationError(`${provider.name} isn't supported`);
  return sdk.create(settings, provider.id);
}

// What went wrong, in words the user can act on; provider bodies never carry our secrets.
export function describeFailure(err: unknown, provider: string, modelId: string) {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (status === 401 || status === 403) return `${provider} rejected these credentials`;
    if (status === 404)
      return `${provider} has no model called ${modelId}, or this key can't use it`;
    if (status === 429) return `${provider} is rate limiting this key, or it has run out of quota`;
    const detail = err.responseBody?.slice(0, 200) ?? err.message;
    return `${provider} answered ${status ?? 'with an error'}: ${detail}`;
  }
  const error = err as Error;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return `${provider} didn't answer in time`;
  }
  return `Couldn't reach ${provider}: ${error.message.slice(0, 200)}`;
}

// A real call with the user's settings, so a bad key or model is caught before saving.
// Embedding models also report how many dimensions they return.
export async function probe(
  provider: DirectoryProvider,
  kind: ModelKind,
  modelId: string,
  settings: Settings,
  timeoutMs: number,
): Promise<{ dimensions: number | null }> {
  const sdk = connect(provider, settings);
  const abortSignal = AbortSignal.timeout(timeoutMs);
  try {
    if (kind === 'embedding') {
      if (!sdk.embeddingModel)
        throw new ValidationError(`${provider.name} has no embedding models`);
      const { embedding } = await embed({
        model: sdk.embeddingModel(modelId),
        value: 'OneBox connection test',
        maxRetries: 0,
        abortSignal,
      });
      return { dimensions: embedding.length };
    }
    await generateText({
      model: sdk.languageModel(modelId),
      prompt: 'Reply with OK.',
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal,
    });
    return { dimensions: null };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(describeFailure(err, provider.name, modelId), {
      code: 'PROVIDER_CHECK_FAILED',
    });
  }
}

// Models the user's own server offers (OpenAI-compatible ones list them); the catalogue's otherwise.
export async function discoverModels(
  provider: DirectoryProvider,
  settings: Settings,
  timeoutMs: number,
): Promise<string[]> {
  if (provider.npm !== '@ai-sdk/openai-compatible' || !settings.baseURL) {
    return provider.models.map((model) => model.id);
  }
  try {
    const response = await fetch(`${settings.baseURL.replace(/\/$/, '')}/models`, {
      headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok)
      throw new APICallError({
        message: 'list failed',
        url: '',
        requestBodyValues: {},
        statusCode: response.status,
      });
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string');
  } catch (err) {
    throw new ValidationError(describeFailure(err, provider.name, 'models'), {
      code: 'PROVIDER_CHECK_FAILED',
    });
  }
}
