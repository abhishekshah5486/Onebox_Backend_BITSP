import { describe, expect, it } from 'vitest';
import { SDKS } from './sdks';

const SAMPLE: Record<string, string> = {
  apiKey: 'k',
  baseURL: 'https://example.test/v1',
  resourceName: 'res',
  region: 'us-east-1',
  project: 'p',
  location: 'us-central1',
  credentials: '{"client_email":"a@b.c","private_key":"x"}',
};

describe('SDKS', () => {
  it.each(Object.keys(SDKS))('%s builds a model from its settings', (npm) => {
    const sdk = SDKS[npm]!;
    for (const key of sdk.required) expect(sdk.settings).toContain(key);
    const settings = Object.fromEntries(sdk.settings.map((key) => [key, SAMPLE[key] ?? 'x']));
    const model = sdk.create(settings, 'test').languageModel('some-model');
    expect(model.modelId).toBe('some-model');
  });
});
