import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { createLogger } from '@onebox/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { createEmbedder, embeddingModel, type Embedder, type EmbeddingSettings } from './embed';

const logger = createLogger({ service: 'test', level: 'silent' });
const userId = '6f1c2b8e-1a4d-4c7e-9b1a-2f3e4d5c6b7a';

function stubOpenAi(status = 200) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(init.body as string) as { input: string[] };
    // Out of order on purpose: results are matched to texts by index.
    const data = input.map((_, index) => ({ index, embedding: [index, 0.5] })).reverse();
    return new Response(
      status === 200 ? JSON.stringify({ data, usage: { total_tokens: 2_000_000 } }) : 'nope',
      { status },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const billing = (allowed = true) => ({
  allowed: vi.fn(async () => allowed),
  charge: vi.fn(async () => {}),
});

afterEach(() => vi.unstubAllGlobals());

// The stub answers two numbers per text.
const settings = (overrides: Partial<EmbeddingSettings> = {}): EmbeddingSettings => ({
  provider: 'openai',
  model: undefined,
  dimensions: 2,
  ollamaUrl: 'http://ollama:11434/',
  openAiKey: 'k',
  ...overrides,
});
const openAi = (openAiKey: string | undefined = 'k') => embeddingModel(settings({ openAiKey }));

describe('createEmbedder', () => {
  it('returns one vector per text, in order, at the shortened size', async () => {
    const fetchMock = stubOpenAi();
    const embed = createEmbedder({ model: openAi(), logger });
    const result = await embed({ userId, texts: ['a', 'b'], charge: false });
    expect(result.vectors).toEqual([
      [0, 0.5],
      [1, 0.5],
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'text-embedding-3-large', dimensions: 2 });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/embeddings');
  });

  it('charges searches but not indexing', async () => {
    stubOpenAi();
    const paid = billing();
    const embed = createEmbedder({ model: openAi(), billing: paid, logger });

    await embed({ userId, texts: ['a'], charge: false });
    expect(paid.charge).not.toHaveBeenCalled();

    await embed({ userId, texts: ['a'], charge: true });
    expect(paid.charge).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        purpose: 'search',
        model: 'openai/text-embedding-3-large',
        costUsd: 0.26,
      }),
    );
  });

  it('refuses a charged search without credits, and fails cleanly without a key', async () => {
    stubOpenAi();
    const broke = createEmbedder({ model: openAi(), billing: billing(false), logger });
    await expect(broke({ userId, texts: ['a'], charge: true })).rejects.toMatchObject({
      statusCode: 402,
    });
    const keyless = createEmbedder({
      model: embeddingModel(settings({ openAiKey: undefined })),
      logger,
    });
    await expect(keyless({ userId, texts: ['a'], charge: false })).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('reports a provider failure as an upstream error', async () => {
    stubOpenAi(500);
    const embed = createEmbedder({ model: openAi(), logger });
    await expect(embed({ userId, texts: ['a'], charge: false })).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it('treats a rejected key like a missing one', async () => {
    stubOpenAi(401);
    const embed = createEmbedder({ model: openAi('wrong'), logger });
    await expect(embed({ userId, texts: ['a'], charge: false })).rejects.toMatchObject({
      statusCode: 503,
      code: 'EMBEDDINGS_UNAVAILABLE',
    });
  });

  it('uses a local Ollama model by default, free and without a key', async () => {
    const fetchMock = stubOpenAi();
    const paid = billing();
    const model = embeddingModel(settings({ provider: 'ollama', openAiKey: undefined }));
    const embed = createEmbedder({ model, billing: paid, logger });
    expect(embed.model).toEqual({
      id: 'ollama/bge-m3',
      name: 'bge-m3 (local)',
      dimensions: 2,
      local: true,
    });

    await embed({ userId, texts: ['a'], charge: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://ollama:11434/v1/embeddings');
    expect(init.headers).not.toHaveProperty('authorization');
    // Ollama models always return their own size, so none is asked for.
    expect(JSON.parse(init.body as string)).toEqual({ model: 'bge-m3', input: ['a'] });
    expect(paid.charge).not.toHaveBeenCalled();
  });

  it('refuses vectors of another size than the index expects', async () => {
    stubOpenAi();
    const model = embeddingModel(settings({ provider: 'ollama', dimensions: 1024 }));
    await expect(
      createEmbedder({ model, logger })({ userId, texts: ['a'], charge: false }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('embedding routes', () => {
  const localModel = { id: 'ollama/bge-m3', name: 'bge-m3 (local)', dimensions: 1024, local: true };
  const embed: Embedder = Object.assign(
    vi.fn(async () => ({ model: 'm', dimensions: 2, vectors: [[1, 2]] })),
    { model: localModel },
  );
  const app = buildApp({
    logger,
    checks: {},
    routes: {
      catalog: { list: async () => [], choices: async () => ({}) } as never,
      complete: vi.fn(),
      embed,
      usage: {} as never,
      verifyToken: vi.fn(async () => ({ userId, email: 'a@b.c' })),
      internalToken: 'secret',
    },
  });

  it('shows signed-in users which model search embeds with', async () => {
    const res = await app.inject({ url: '/llm/models', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ embedding: unknown }>().embedding).toEqual(localModel);
  });

  it('only answers other OneBox services on internal routes', async () => {
    const body = { userId, texts: ['hello'], charge: false };

    const outside = await app.inject({ method: 'POST', url: '/internal/embed', payload: body });
    expect(outside.statusCode).toBe(401);

    const inside = await app.inject({
      method: 'POST',
      url: '/internal/embed',
      headers: { [INTERNAL_TOKEN_HEADER]: 'secret' },
      payload: body,
    });
    expect(inside.statusCode).toBe(200);
    expect(inside.json()).toEqual({ model: 'm', dimensions: 2, vectors: [[1, 2]] });
    expect(embed).toHaveBeenCalledWith(body);

    const model = await app.inject({
      url: '/internal/embed/model',
      headers: { [INTERNAL_TOKEN_HEADER]: 'secret' },
    });
    expect(model.json()).toEqual(localModel);
    expect((await app.inject({ url: '/internal/embed/model' })).statusCode).toBe(401);
  });
});
