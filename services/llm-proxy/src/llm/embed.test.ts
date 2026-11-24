import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { createLogger } from '@onebox/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { createEmbedder, createEmbeddings, type EmbeddingModel } from './embed';

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
const openAiModel = (overrides: Partial<EmbeddingModel> = {}): EmbeddingModel => ({
  id: 'openai/text-embedding-3-large',
  apiName: 'text-embedding-3-large',
  name: 'OpenAI text-embedding-3-large',
  dimensions: 2,
  usdPerMillionTokens: 0.13,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  needsKey: true,
  sendDimensions: true,
  local: false,
  contextTokens: 8191,
  ...overrides,
});
const ollamaModel = (overrides: Partial<EmbeddingModel> = {}): EmbeddingModel => ({
  id: 'ollama/bge-m3',
  apiName: 'bge-m3',
  name: 'bge-m3',
  dimensions: 2,
  usdPerMillionTokens: 0,
  baseUrl: 'http://ollama:11434/v1',
  apiKey: undefined,
  needsKey: false,
  sendDimensions: false,
  local: true,
  contextTokens: 8192,
  ...overrides,
});
const openAi = (apiKey: string | undefined = 'k') => openAiModel({ apiKey });

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
    const keyless = createEmbedder({ model: openAiModel({ apiKey: undefined }), logger });
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

  it('embeds with a local Ollama model for free and without a key', async () => {
    const fetchMock = stubOpenAi();
    const paid = billing();
    const embed = createEmbedder({ model: ollamaModel(), billing: paid, logger });
    expect(embed.model).toEqual({
      id: 'ollama/bge-m3',
      name: 'bge-m3',
      dimensions: 2,
      local: true,
      contextTokens: 8192,
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
    await expect(
      createEmbedder({ model: ollamaModel({ dimensions: 1024 }), logger })({
        userId,
        texts: ['a'],
        charge: false,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('createEmbeddings', () => {
  it("embeds with the model asked for, else the user's pick", async () => {
    const fetchMock = stubOpenAi();
    const resolve = vi.fn(async (_userId: string | undefined, id?: string) =>
      id === 'openai/text-embedding-3-large' ? openAi() : ollamaModel(),
    );
    const embed = createEmbeddings({ catalog: { resolve }, logger });

    await embed({ userId, texts: ['a'], charge: false });
    await embed({ userId, texts: ['a'], charge: false, model: 'openai/text-embedding-3-large' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://ollama:11434/v1/embeddings',
      'https://api.openai.com/v1/embeddings',
    ]);
    expect(resolve).toHaveBeenNthCalledWith(1, userId, undefined);
    await expect(embed.modelFor(userId)).resolves.toMatchObject({
      id: 'ollama/bge-m3',
      contextTokens: 8192,
    });
  });
});

describe('embedding routes', () => {
  const localModel = {
    id: 'ollama/bge-m3',
    name: 'bge-m3',
    dimensions: 1024,
    local: true,
    contextTokens: 8192,
  };
  const embed = Object.assign(
    vi.fn(async () => ({ model: 'm', dimensions: 2, vectors: [[1, 2]] })),
    { modelFor: vi.fn(async () => localModel) },
  );
  let chosen = 'ollama/bge-m3';
  const embeddingCatalog = {
    defaultModel: 'ollama/bge-m3',
    list: vi.fn(async () => [{ id: 'ollama/nomic-embed-text' }]),
    choiceOf: vi.fn(async () => chosen),
    choose: vi.fn(async (_userId: string, modelId: string) => {
      chosen = modelId;
      return { id: modelId };
    }),
  };
  const reembed = vi.fn(async () => {});
  const app = buildApp({
    logger,
    checks: {},
    routes: {
      catalog: {} as never,
      complete: vi.fn(),
      embed,
      embeddingCatalog: embeddingCatalog as never,
      directory: {} as never,
      userModels: {} as never,
      reembed,
      usage: {} as never,
      verifyToken: vi.fn(async () => ({ userId, email: 'a@b.c' })),
      internalToken: 'secret',
    },
  });
  const auth = { authorization: 'Bearer t' };

  it("lists the models with the user's pick, and rebuilds only when the pick changes", async () => {
    const list = await app.inject({ url: '/llm/embeddings', headers: auth });
    expect(list.json()).toEqual({
      items: [{ id: 'ollama/nomic-embed-text' }],
      chosen: 'ollama/bge-m3',
      default: 'ollama/bge-m3',
    });

    const pick = (modelId: string) =>
      app.inject({
        method: 'PUT',
        url: '/llm/embeddings/choice',
        headers: auth,
        payload: { modelId },
      });
    expect((await pick('ollama/nomic-embed-text')).json()).toEqual({
      chosen: 'ollama/nomic-embed-text',
    });
    expect(reembed).toHaveBeenCalledWith(userId, 'ollama/nomic-embed-text');
    await pick('ollama/nomic-embed-text');
    expect(reembed).toHaveBeenCalledOnce();
  });

  it('only answers other OneBox services on internal routes', async () => {
    const body = { userId, texts: ['hello'], charge: false };

    const outside = await app.inject({ method: 'POST', url: '/internal/embed', payload: body });
    expect(outside.statusCode).toBe(401);

    const inside = await app.inject({
      method: 'POST',
      url: '/internal/embed',
      headers: { [INTERNAL_TOKEN_HEADER]: 'secret' },
      payload: { ...body, model: 'ollama/bge-m3' },
    });
    expect(inside.statusCode).toBe(200);
    expect(inside.json()).toEqual({ model: 'm', dimensions: 2, vectors: [[1, 2]] });
    expect(embed).toHaveBeenCalledWith({ ...body, model: 'ollama/bge-m3' });

    const model = await app.inject({
      url: `/internal/embed/model?userId=${userId}`,
      headers: { [INTERNAL_TOKEN_HEADER]: 'secret' },
    });
    expect(model.json()).toEqual(localModel);
    expect(embed.modelFor).toHaveBeenCalledWith(userId);
    expect((await app.inject({ url: '/internal/embed/model' })).statusCode).toBe(401);
  });
});
