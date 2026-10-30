import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbedClient } from './embed-client';

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
