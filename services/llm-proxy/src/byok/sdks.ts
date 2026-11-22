import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createCohere } from '@ai-sdk/cohere';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createPerplexity } from '@ai-sdk/perplexity';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createXai } from '@ai-sdk/xai';
import type { EmbeddingModelV4, LanguageModelV4 } from '@ai-sdk/provider';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export type Settings = Record<string, string>;

export interface SdkProvider {
  languageModel(modelId: string): LanguageModelV4;
  embeddingModel?(modelId: string): EmbeddingModelV4;
}

interface Sdk {
  // The settings its factory takes, in the order a form shows them.
  settings: string[];
  required: string[];
  // Its API key is one of several ways in, e.g. Bedrock's access key pair instead.
  optionalKey?: boolean;
  create(settings: Settings, providerId: string): SdkProvider;
}

const base = (settings: Settings) => ({
  ...(settings.apiKey && { apiKey: settings.apiKey }),
  ...(settings.baseURL && { baseURL: settings.baseURL }),
});

const keyed = (create: (options: ReturnType<typeof base>) => SdkProvider): Sdk => ({
  settings: ['apiKey'],
  required: ['apiKey'],
  create: (settings) => create(base(settings)),
});

// Every AI SDK package OneBox can talk through, keyed by npm name as models.dev lists it.
export const SDKS: Record<string, Sdk> = {
  '@ai-sdk/openai': keyed(createOpenAI),
  '@ai-sdk/anthropic': keyed(createAnthropic),
  '@ai-sdk/google': keyed(createGoogleGenerativeAI),
  '@ai-sdk/mistral': keyed(createMistral),
  '@ai-sdk/cohere': keyed(createCohere),
  '@ai-sdk/groq': keyed(createGroq),
  '@ai-sdk/xai': keyed(createXai),
  '@ai-sdk/togetherai': keyed(createTogetherAI),
  '@ai-sdk/perplexity': keyed(createPerplexity),
  '@openrouter/ai-sdk-provider': keyed((options) => createOpenRouter(options)),
  '@ai-sdk/openai-compatible': {
    settings: ['baseURL', 'apiKey'],
    required: ['baseURL'],
    create: (settings, providerId) =>
      createOpenAICompatible({
        name: providerId,
        baseURL: settings.baseURL ?? '',
        ...base(settings),
      }),
  },
  '@ai-sdk/azure': {
    settings: ['resourceName', 'apiKey', 'apiVersion'],
    required: ['resourceName', 'apiKey'],
    create: (settings) =>
      createAzure({
        resourceName: settings.resourceName,
        apiKey: settings.apiKey,
        ...(settings.apiVersion && { apiVersion: settings.apiVersion }),
      }),
  },
  // Either an access key pair or a Bedrock API key.
  '@ai-sdk/amazon-bedrock': {
    settings: ['region', 'accessKeyId', 'secretAccessKey', 'apiKey'],
    required: ['region'],
    optionalKey: true,
    create: (settings) =>
      createAmazonBedrock({
        region: settings.region,
        ...(settings.apiKey
          ? { apiKey: settings.apiKey }
          : { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey }),
      }),
  },
  '@ai-sdk/google-vertex': {
    settings: ['project', 'location', 'credentials'],
    required: ['project', 'location', 'credentials'],
    create: (settings) =>
      createVertex({
        project: settings.project,
        location: settings.location,
        googleAuthOptions: { credentials: JSON.parse(settings.credentials ?? '{}') as object },
      }),
  },
};

export const sdkFor = (npm: string | undefined) => (npm ? SDKS[npm] : undefined);
