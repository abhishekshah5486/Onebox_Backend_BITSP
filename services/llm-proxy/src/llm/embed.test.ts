import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { createLogger } from '@onebox/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { createEmbedder, EMBEDDING_MODEL, type Embedder } from './embed';

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

describe('createEmbedder', () => {
  it('returns one vector per text, in order, at the shortened size', async () => {
    const fetchMock = stubOpenAi();
    const embed = createEmbedder({ apiKey: 'k', logger });
    const result = await embed({ userId, texts: ['a', 'b'], charge: false });
    expect(result.vectors).toEqual([
      [0, 0.5],
      [1, 0.5],
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'text-embedding-3-large', dimensions: 1024 });
  });

  it('charges searches but not indexing', async () => {
    stubOpenAi();
    const paid = billing();
    const embed = createEmbedder({ apiKey: 'k', billing: paid, logger });

    await embed({ userId, texts: ['a'], charge: false });
    expect(paid.charge).not.toHaveBeenCalled();

    await embed({ userId, texts: ['a'], charge: true });
    expect(paid.charge).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ purpose: 'search', model: EMBEDDING_MODEL.id, costUsd: 0.26 }),
    );
  });

  it('refuses a charged search without credits, and fails cleanly without a key', async () => {
    stubOpenAi();
    const broke = createEmbedder({ apiKey: 'k', billing: billing(false), logger });
    await expect(broke({ userId, texts: ['a'], charge: true })).rejects.toMatchObject({
      statusCode: 402,
    });
    const keyless = createEmbedder({ apiKey: undefined, logger });
    await expect(keyless({ userId, texts: ['a'], charge: false })).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('reports a provider failure as an upstream error', async () => {
    stubOpenAi(500);
    const embed = createEmbedder({ apiKey: 'k', logger });
    await expect(embed({ userId, texts: ['a'], charge: false })).rejects.toMatchObject({
      statusCode: 502,
    });
  });
});

describe('POST /internal/embed', () => {
  it('only answers other OneBox services', async () => {
    const embed: Embedder = vi.fn(async () => ({ model: 'm', dimensions: 2, vectors: [[1, 2]] }));
    const app = buildApp({
      logger,
      checks: {},
      routes: {
        catalog: {} as never,
        complete: vi.fn(),
        embed,
        usage: {} as never,
        verifyToken: vi.fn(),
        internalToken: 'secret',
      },
    });
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
  });
});
