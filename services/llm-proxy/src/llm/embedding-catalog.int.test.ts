import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateLlm } from '../db/migrate';
import { createEmbeddingCatalog } from './embedding-catalog';

const logger = createLogger({ service: 'test', level: 'silent' });
const userId = '6f1c2b8e-1a4d-4c7e-9b1a-2f3e4d5c6b7a';

let pg: TestPostgres;
let client: PgClient;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url);
  await migrateLlm(client, logger);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await pg?.stop();
});

// Ollama with one embedding model and one chat model pulled.
const ollama = {
  list: vi.fn(async () => ({
    models: [
      { name: 'bge-m3:latest', details: { parameter_size: '566M' } },
      { name: 'mistral:latest', details: { parameter_size: '7B' } },
    ],
  })),
  show: vi.fn(async ({ model }: { model: string }) =>
    model.startsWith('bge')
      ? {
          capabilities: ['embedding'],
          model_info: { 'bert.embedding_length': 1024, 'bert.context_length': 8192 },
        }
      : { capabilities: ['completion'], model_info: { 'llama.embedding_length': 4096 } },
  ),
};

const catalogWith = (keys = {}) =>
  createEmbeddingCatalog({
    db: client.db,
    ollama: ollama as never,
    ollamaUrl: 'http://ollama:11434/',
    keys,
    defaultModel: 'ollama/bge-m3',
    logger,
  });

describe('embedding catalog', () => {
  it("lists Ollama's embedding models and the hosted ones, usable once keyed", async () => {
    const items = await catalogWith({ GEMINI: 'g' }).list();
    expect(items.map((item) => [item.id, item.available])).toEqual([
      ['ollama/bge-m3', true],
      ['openai/text-embedding-3-small', false],
      ['openai/text-embedding-3-large', false],
      ['gemini/gemini-embedding-001', true],
    ]);
    expect(items[0]).toMatchObject({
      local: true,
      dimensions: 1024,
      usdPerMillionTokens: 0,
      description: '566M parameters',
      contextTokens: 8192,
    });
    expect(items[3]).toMatchObject({ contextTokens: 2048, usdPerMillionTokens: 0.15 });
  });

  it("keeps each user's pick, falling back to the default", async () => {
    const catalog = catalogWith({ GEMINI: 'g' });
    expect(await catalog.choiceOf(userId)).toBe('ollama/bge-m3');
    await catalog.choose(userId, 'gemini/gemini-embedding-001');
    expect(await catalog.choiceOf(userId)).toBe('gemini/gemini-embedding-001');

    const model = await catalog.resolve(userId);
    expect(model).toMatchObject({
      apiKey: 'g',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      dimensions: 768,
      sendDimensions: true,
    });
    expect((await catalog.resolve(userId, 'ollama/bge-m3')).baseUrl).toBe('http://ollama:11434/v1');
  });

  it('refuses models that are unknown or have no key', async () => {
    const catalog = catalogWith();
    await expect(catalog.choose(userId, 'ollama/nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(catalog.choose(userId, 'openai/text-embedding-3-small')).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('still lists hosted models while Ollama is down', async () => {
    ollama.list.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const items = await catalogWith().list();
    expect(items.map((item) => item.id)).not.toContain('ollama/bge-m3');
    expect(items).toHaveLength(3);
  });
});
