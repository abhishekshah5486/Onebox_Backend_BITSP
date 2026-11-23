import { describe, expect, it } from 'vitest';
import { parseCatalog, settingFor, withExtras } from './directory';
import { catalogFixture } from './fixture';

describe('settingFor', () => {
  it("maps a provider's environment names onto the settings its SDK takes", () => {
    const bedrock = ['region', 'accessKeyId', 'secretAccessKey', 'apiKey'];
    expect(settingFor('AWS_ACCESS_KEY_ID', bedrock)).toBe('accessKeyId');
    expect(settingFor('AWS_SECRET_ACCESS_KEY', bedrock)).toBe('secretAccessKey');
    expect(settingFor('AWS_REGION', bedrock)).toBe('region');
    // A token it has no name for is its API key.
    expect(settingFor('AWS_BEARER_TOKEN_BEDROCK', bedrock)).toBe('apiKey');
    expect(settingFor('GEMINI_API_KEY', ['apiKey'])).toBe('apiKey');
    expect(settingFor('GOOGLE_VERTEX_PROJECT', ['project', 'location'])).toBe('project');
    expect(settingFor('SOME_REGION', ['apiKey'])).toBeNull();
  });
});

describe('parseCatalog', () => {
  const providers = parseCatalog(catalogFixture, 'https://models.dev/logos');
  const byId = (id: string) => providers.find((provider) => provider.id === id)!;

  it('keeps only providers whose SDK OneBox has, sorted by name', () => {
    expect(providers.map((p) => p.id)).toEqual([
      'amazon-bedrock',
      'fireworks-ai',
      'lmstudio',
      'openai',
    ]);
  });

  it('describes models by what they can do and cost, skipping malformed ones', () => {
    const openai = byId('openai');
    expect(openai.logoUrl).toBe('https://models.dev/logos/openai.svg');
    expect(openai.models).toEqual([
      {
        id: 'gpt-5',
        name: 'GPT-5',
        contextTokens: 400000,
        outputTokens: 128000,
        reasoning: true,
        multimodal: true,
        toolCalls: true,
        deprecated: false,
        embedding: false,
        usdPerMillion: { input: 1.25, output: 10 },
      },
      expect.objectContaining({ id: 'text-embedding-3-small', embedding: true, multimodal: false }),
    ]);
  });

  it('asks for the credentials each provider needs', () => {
    const field = (id: string) =>
      byId(id).fields.map(({ key, required, secret }) => ({ key, required, secret }));
    expect(field('openai')).toEqual([{ key: 'apiKey', required: true, secret: true }]);
    // Bedrock takes a key pair or an API key, so only the region is a must.
    expect(field('amazon-bedrock')).toEqual([
      { key: 'region', required: true, secret: false },
      { key: 'accessKeyId', required: false, secret: false },
      { key: 'secretAccessKey', required: false, secret: true },
      { key: 'apiKey', required: false, secret: true },
    ]);
    expect(byId('amazon-bedrock').fields[1]!.label).toBe('Access key ID');
    // A hosted OpenAI-compatible service needs its key; one on the user's machine may not.
    expect(byId('fireworks-ai').fields).toEqual([
      expect.objectContaining({
        key: 'baseURL',
        required: true,
        default: 'https://api.fireworks.ai/inference/v1/',
      }),
      expect.objectContaining({ key: 'apiKey', required: true }),
    ]);
    expect(byId('lmstudio').fields[1]).toMatchObject({ key: 'apiKey', required: false });
  });
});

describe('withExtras', () => {
  const alibaba = {
    id: 'alibaba',
    name: 'Alibaba',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    env: ['DASHSCOPE_API_KEY'],
    models: { 'qwen3-max': { id: 'qwen3-max', name: 'Qwen3 Max' } },
  };

  it('offers Qwen as Alibaba Cloud’s provider under its own name, with its models', () => {
    const qwen = parseCatalog(withExtras({ alibaba }), null).find((p) => p.id === 'qwen');
    expect(qwen).toMatchObject({ name: 'Qwen (Alibaba Cloud)' });
    expect(qwen!.models.map((model) => model.id)).toEqual(['qwen3-max']);
    expect(qwen!.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'baseURL', default: alibaba.api }),
        expect.objectContaining({ key: 'apiKey', required: true }),
      ]),
    );
  });

  it('adds the UAE labs’ APIs, and Falcon for a server of the user’s own', () => {
    const ids = parseCatalog(withExtras({}), null).map((provider) => provider.id);
    expect(ids).toEqual(expect.arrayContaining(['core42', 'ifm', 'falcon']));
    // Nothing to inherit from: left out rather than half-made.
    expect(ids).not.toContain('qwen');
    const falcon = parseCatalog(withExtras({}), null).find((p) => p.id === 'falcon');
    expect(falcon!.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'apiKey', required: false })]),
    );
  });

  it('lets models.dev’s own entry win once it lists one', () => {
    const listed = { ...alibaba, id: 'ifm', name: 'IFM' };
    expect(
      parseCatalog(withExtras({ ifm: listed }), null).find((p) => p.id === 'ifm'),
    ).toMatchObject({ name: 'IFM' });
  });
});
