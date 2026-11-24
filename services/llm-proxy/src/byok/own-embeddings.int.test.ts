import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { migrateLlm } from '../db/migrate';
import type { Billing } from '../llm/billing';
import { createEmbeddings } from '../llm/embed';
import { createEmbeddingCatalog } from '../llm/embedding-catalog';
import { CUSTOM_PROVIDER } from './directory';
import { createUserModels } from './user-models';

const logger = createLogger({ service: 'test', level: 'silent' });
const userId = '6f1c2b8e-1a4d-4c7e-9b1a-2f3e4d5c6b7a';
const KEY = 'sk-own-embed-key-9999';

// The user's own embedding server: 4-dimensional vectors.
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
  req.on('end', () => {
    const { input } = JSON.parse(raw) as { input: string[] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [index, 1, 2, 3] })),
        usage: { prompt_tokens: 10 },
      }),
    );
  });
});

let pg: TestPostgres;
let client: PgClient;
let app: ReturnType<typeof buildApp>;
const reembed = vi.fn(async () => {});
const charge = vi.fn(async () => {});
const billing: Billing = { allowed: async () => true, charge };

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url);
  await migrateLlm(client, logger);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const userModels = createUserModels({
    db: client.db,
    encryptionKey: Buffer.alloc(32, 5),
    directory: { provider: async (id) => (id === CUSTOM_PROVIDER.id ? CUSTOM_PROVIDER : null) },
    allowPrivateUrls: true,
    timeoutMs: 5_000,
    logger,
  });
  const embeddingCatalog = createEmbeddingCatalog({
    db: client.db,
    // No local models in this test.
    ollama: { list: async () => ({ models: [] }), show: async () => ({}) } as never,
    ollamaUrl: 'http://ollama.test',
    keys: {},
    defaultModel: 'ollama/bge-m3',
    logger,
    userModels,
  });
  app = buildApp({
    logger,
    checks: {},
    routes: {
      catalog: {} as never,
      complete: vi.fn(),
      embed: createEmbeddings({ catalog: embeddingCatalog, billing, logger }),
      embeddingCatalog,
      reembed,
      usage: {} as never,
      directory: {} as never,
      userModels,
      verifyToken: vi.fn(async () => ({ userId, email: 'a@b.c' })),
      internalToken: 'secret',
    },
  });
  const added = await app.inject({
    method: 'POST',
    url: '/llm/user-models',
    headers: { authorization: 'Bearer t' },
    payload: {
      kind: 'embedding',
      providerId: 'openai-compatible',
      modelId: 'my-embedder',
      settings: { baseURL, apiKey: KEY },
    },
  });
  expect(added.statusCode).toBe(201);
}, 120_000);

afterAll(async () => {
  server.close();
  await client?.close();
  await pg?.stop();
});

const auth = { authorization: 'Bearer t' };

describe("a user's own embedding model", () => {
  it('can be picked for semantic search, and embeds with their key at no cost', async () => {
    const list = await app.inject({ url: '/llm/embeddings', headers: auth });
    const { items } = list.json<{ items: { id: string; own: boolean; dimensions: number }[] }>();
    const own = items.find((item) => item.own)!;
    expect(own).toMatchObject({ dimensions: 4, own: true });

    const picked = await app.inject({
      method: 'PUT',
      url: '/llm/embeddings/choice',
      headers: auth,
      payload: { modelId: own.id },
    });
    expect(picked.json()).toEqual({ chosen: own.id });
    expect(reembed).toHaveBeenCalledWith(userId, own.id);

    const model = await app.inject({
      url: `/internal/embed/model?userId=${userId}`,
      headers: { [INTERNAL_TOKEN_HEADER]: 'secret' },
    });
    expect(model.json()).toMatchObject({ id: own.id, dimensions: 4, local: false });
    const embedded = await app.inject({
      method: 'POST',
      url: '/internal/embed',
      headers: { [INTERNAL_TOKEN_HEADER]: 'secret' },
      payload: { userId, texts: ['a', 'b'], charge: true },
    });
    expect(embedded.json()).toEqual({
      model: own.id,
      dimensions: 4,
      vectors: [
        [0, 1, 2, 3],
        [1, 1, 2, 3],
      ],
    });
    expect(charge).not.toHaveBeenCalled();

    // Removing it moves search back to the default model, embedding the mail again.
    reembed.mockClear();
    const removed = await app.inject({
      method: 'DELETE',
      url: `/llm/user-models/${own.id.slice('user:'.length)}`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
    expect(reembed).toHaveBeenCalledWith(userId, 'ollama/bge-m3');
    const after = await app.inject({ url: '/llm/embeddings', headers: auth });
    expect(after.json()).toMatchObject({ chosen: 'ollama/bge-m3' });
  });
});
