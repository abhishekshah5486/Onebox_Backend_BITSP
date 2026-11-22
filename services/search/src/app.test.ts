import { PaymentRequiredError, UnauthorizedError } from '@onebox/errors';
import { createLogger } from '@onebox/logger';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import type { KeywordIndex } from './keyword/keyword-index';
import type { RebuildState, SemanticModels } from './semantic/models';

const logger = createLogger({ service: 'test', level: 'silent' });
const verifyToken = async (token: string) => {
  if (token !== 'good') throw new UnauthorizedError('bad token');
  return { userId: 'u1', email: 'me@example.com' };
};
const auth = { authorization: 'Bearer good' };

function setup() {
  const keyword = {
    search: vi.fn(async () => ({
      hits: [
        { threadId: 't2', messageId: 'm2', score: null, highlights: ['<mark>trip</mark>'] },
        { threadId: 't1', messageId: 'm1', score: null, highlights: [] },
      ],
      total: 30,
    })),
  };
  const vector = {
    search: vi.fn(async (_u: string, _v: number[], _q: unknown, limit: number) =>
      Array.from({ length: limit }, (_, i) => ({
        threadId: `t${i}`,
        messageId: `m${i}`,
        score: 0.9,
      })),
    ),
  };
  const active = { id: 'ollama/bge-m3', name: 'bge-m3', dimensions: 1024, local: true };
  const models = {
    active: vi.fn(async () => active),
    indexFor: vi.fn(async () => vector),
    rebuildOf: vi.fn(async (): Promise<RebuildState | null> => null),
  };
  const embed = vi.fn(async () => [[0.1, 0.2]]);
  const lookupThreads = vi.fn(async (_auth: string, ids: string[]) =>
    ids.filter((id) => id !== 'gone').map((id) => ({ id })),
  );
  const app = buildApp({
    logger,
    checks: {},
    keyword: keyword as unknown as KeywordIndex,
    models: models as unknown as SemanticModels,
    embed,
    lookupThreads,
    verifyToken,
  });
  return { app, keyword, vector, models, embed, lookupThreads };
}

describe('GET /search', () => {
  it('needs a signed-in user', async () => {
    const { app } = setup();
    const response = await app.inject({ url: '/search?q=trip' });
    expect(response.statusCode).toBe(401);
  });

  it('returns keyword hits as conversations in rank order', async () => {
    const { app, keyword, lookupThreads, embed } = setup();
    const response = await app.inject({ url: '/search?q=trip&pageSize=2', headers: auth });
    expect(response.json()).toEqual({
      mode: 'keyword',
      items: [
        { thread: { id: 't2' }, messageId: 'm2', score: null, highlights: ['<mark>trip</mark>'] },
        { thread: { id: 't1' }, messageId: 'm1', score: null, highlights: [] },
      ],
      total: 30,
      nextPage: 1,
    });
    expect(keyword.search).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ words: ['trip'] }),
      {
        from: 0,
        size: 2,
      },
    );
    expect(lookupThreads).toHaveBeenCalledWith('Bearer good', ['t2', 't1']);
    expect(embed).not.toHaveBeenCalled();
  });

  it('charges the user to embed a semantic query and pages through the ranking', async () => {
    const { app, vector, embed } = setup();
    const response = await app.inject({
      url: '/search?q=from:alice%20trips%20abroad&mode=semantic&page=1&pageSize=3',
      headers: auth,
    });
    const body = response.json<{
      mode: string;
      items: { messageId: string }[];
      nextPage: number;
    }>();
    // With the model the user's mail is embedded with.
    expect(embed).toHaveBeenCalledWith({
      userId: 'u1',
      texts: ['trips abroad'],
      charge: true,
      model: 'ollama/bge-m3',
    });
    expect(vector.search).toHaveBeenCalledWith('u1', [0.1, 0.2], expect.anything(), 6);
    expect(body.mode).toBe('semantic');
    expect(body.items.map((item) => item.messageId)).toEqual(['m3', 'm4', 'm5']);
    expect(body.nextPage).toBe(2);
  });

  it('falls back to keyword search when only operators are given', async () => {
    const { app, embed } = setup();
    const response = await app.inject({ url: '/search?q=from:alice&mode=semantic', headers: auth });
    expect(response.json<{ mode: string }>().mode).toBe('keyword');
    expect(embed).not.toHaveBeenCalled();
  });

  it('drops conversations that no longer exist', async () => {
    const { app, keyword } = setup();
    keyword.search.mockResolvedValueOnce({
      hits: [{ threadId: 'gone', messageId: 'm9', score: null, highlights: [] }],
      total: 1,
    });
    const response = await app.inject({ url: '/search?q=x', headers: auth });
    expect(response.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('reports running out of credits', async () => {
    const { app, embed } = setup();
    embed.mockRejectedValueOnce(new PaymentRequiredError('out', { code: 'OUT_OF_CREDITS' }));
    const response = await app.inject({ url: '/search?q=trip&mode=semantic', headers: auth });
    expect(response.statusCode).toBe(402);
  });

  it('rejects an unknown mode', async () => {
    const { app } = setup();
    const response = await app.inject({ url: '/search?q=x&mode=fuzzy', headers: auth });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /search/semantic', () => {
  it("reports the user's model and how far a switch has got", async () => {
    const { app, models } = setup();
    models.rebuildOf.mockResolvedValueOnce({
      modelId: 'ollama/nomic-embed-text',
      done: 64,
      total: 200,
    });
    const response = await app.inject({ url: '/search/semantic', headers: auth });
    expect(response.json()).toEqual({
      active: { id: 'ollama/bge-m3', name: 'bge-m3', dimensions: 1024, local: true },
      rebuild: { modelId: 'ollama/nomic-embed-text', done: 64, total: 200 },
    });
    expect((await app.inject({ url: '/search/semantic' })).statusCode).toBe(401);
  });
});
