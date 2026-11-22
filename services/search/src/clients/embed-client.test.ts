import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectionFor, createEmbedClient, fetchEmbedModel } from './embed-client';

const answer = (status: number, body: unknown = {}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

afterEach(() => vi.unstubAllGlobals());

describe('createEmbedClient', () => {
  const embed = createEmbedClient('http://llm-proxy', 'token');
  const request = { userId: 'u1', texts: ['hi'], charge: true };

  it('signs the call and returns the vectors', async () => {
    answer(200, { vectors: [[1, 2]] });
    await expect(embed(request)).resolves.toEqual([[1, 2]]);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect((url as URL).href).toBe('http://llm-proxy/internal/embed');
    expect((init?.headers as Record<string, string>)[INTERNAL_TOKEN_HEADER]).toBe('token');
  });

  it('stops retrying when AI search is not set up', async () => {
    answer(503);
    await expect(embed(request)).rejects.toMatchObject({
      code: 'EMBEDDINGS_OFF',
      retryable: false,
    });
  });

  it('reports missing credits, and retries other failures', async () => {
    answer(402);
    await expect(embed(request)).rejects.toMatchObject({ statusCode: 402 });
    answer(502);
    await expect(embed(request)).rejects.toMatchObject({ statusCode: 502, retryable: true });
  });
});

describe('fetchEmbedModel', () => {
  const model = { id: 'ollama/bge-m3', name: 'bge-m3', dimensions: 1024, local: true };

  it('waits for llm-proxy, then returns its model', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify(model)));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();
    await expect(fetchEmbedModel('http://llm-proxy', 'token', { onRetry })).resolves.toEqual(model);
    expect(onRetry).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[1]![0] as URL).href).toBe('http://llm-proxy/internal/embed/model');
  });

  it("asks for a user's own model", async () => {
    answer(200, model);
    await fetchEmbedModel('http://llm-proxy', 'token', { userId: 'u1' });
    expect((vi.mocked(fetch).mock.calls[0]![0] as URL).href).toBe(
      'http://llm-proxy/internal/embed/model?userId=u1',
    );
  });

  it('gives up after its retries', async () => {
    answer(500);
    await expect(fetchEmbedModel('http://llm-proxy', 'token', { retries: 0 })).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it('names a collection per model and size', () => {
    expect(collectionFor(model)).toBe('mail_ollama_bge_m3_1024');
    expect(collectionFor({ ...model, id: 'openai/text-embedding-3-large' })).toBe(
      'mail_openai_text_embedding_3_large_1024',
    );
  });
});
