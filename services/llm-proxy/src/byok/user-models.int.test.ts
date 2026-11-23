import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { migrateLlm } from '../db/migrate';
import { userModels as userModelsTable } from '../db/schema';
import { CUSTOM_PROVIDER, parseCatalog } from './directory';
import { catalogFixture } from './fixture';
import { createUserModels } from './user-models';

const logger = createLogger({ service: 'test', level: 'silent' });
const alice = '6f1c2b8e-1a4d-4c7e-9b1a-2f3e4d5c6b7a';
const bob = '7a2d3c9f-2b5e-4d8f-8c2b-3a4f5e6d7c8b';
const GOOD_KEY = 'sk-test-good-key-1234';

// An OpenAI-compatible provider: one key works, one chat model and one embedding model.
const calls: string[] = [];
const provider = createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(401, { error: 'bad key' });
  let raw = '';
  req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
  req.on('end', () => {
    const body = raw ? (JSON.parse(raw) as { model?: string }) : {};
    if (req.url === '/v1/models') return send(200, { data: [{ id: 'chat-1' }, { id: 'embed-1' }] });
    if (req.url === '/v1/chat/completions' && body.model === 'chat-1') {
      return send(200, {
        id: 'c',
        created: 0,
        model: 'chat-1',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    }
    if (req.url === '/v1/embeddings' && body.model === 'embed-1') {
      return send(200, {
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 3 },
      });
    }
    send(404, { error: 'no such model' });
  });
});

let pg: TestPostgres;
let client: PgClient;
let baseURL: string;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url);
  await migrateLlm(client, logger);
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
  const providers = [...parseCatalog(catalogFixture, null), CUSTOM_PROVIDER];
  app = buildApp({
    logger,
    checks: {},
    routes: {
      catalog: {} as never,
      complete: vi.fn(),
      embed: {} as never,
      embeddingCatalog: {} as never,
      reembed: vi.fn(),
      usage: {} as never,
      directory: {} as never,
      userModels: createUserModels({
        db: client.db,
        encryptionKey: Buffer.alloc(32, 7),
        directory: { provider: async (id) => providers.find((p) => p.id === id) ?? null },
        allowPrivateUrls: true,
        timeoutMs: 5_000,
        logger,
      }),
      verifyToken: vi.fn(async (token: string) => ({
        userId: token === 'bob' ? bob : alice,
        email: 'a@b.c',
      })),
      internalToken: 'secret',
    },
  });
}, 120_000);

afterAll(async () => {
  provider.close();
  await client?.close();
  await pg?.stop();
});

// Errors come back as { error: { code, message } }.
const as = (who = 'alice') => ({ authorization: `Bearer ${who}` });
const add = (payload: Record<string, unknown>, who = 'alice') =>
  app.inject({ method: 'POST', url: '/llm/user-models', headers: as(who), payload });

describe('user models', () => {
  it('lists the models a server offers once its details are filled in', async () => {
    const found = await app.inject({
      method: 'POST',
      url: '/llm/providers/openai-compatible/models',
      headers: as(),
      payload: { settings: { baseURL, apiKey: GOOD_KEY } },
    });
    expect(found.json()).toEqual({ items: ['chat-1', 'embed-1'] });
    const refused = await app.inject({
      method: 'POST',
      url: '/llm/providers/openai-compatible/models',
      headers: as(),
      payload: { settings: { baseURL, apiKey: 'wrong' } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { message: string } }>().error.message).toBe(
      'OpenAI compatible rejected these credentials',
    );
  });

  it('tries the credentials before saving them, and keeps them encrypted', async () => {
    const badKey = await add({
      kind: 'llm',
      providerId: 'openai-compatible',
      modelId: 'chat-1',
      settings: { baseURL, apiKey: 'sk-wrong-key-000000' },
    });
    expect(badKey.json<{ error: { message: string } }>().error.message).toMatch(
      /rejected these credentials/,
    );
    const badModel = await add({
      kind: 'llm',
      providerId: 'openai-compatible',
      modelId: 'nope',
      settings: { baseURL, apiKey: GOOD_KEY },
    });
    expect(badModel.json<{ error: { message: string } }>().error.message).toMatch(
      /no model called nope/,
    );
    const missing = await add({
      kind: 'llm',
      providerId: 'openai-compatible',
      modelId: 'chat-1',
      settings: {},
    });
    expect(missing.json<{ error: { message: string } }>().error.message).toBe(
      'Base URL is required',
    );

    const chat = await add({
      kind: 'llm',
      providerId: 'openai-compatible',
      modelId: 'chat-1',
      name: 'My chat',
      settings: { baseURL, apiKey: GOOD_KEY, ignored: 'x' },
      reasoning: true,
    });
    expect(chat.statusCode).toBe(201);
    expect(chat.json()).toMatchObject({
      kind: 'llm',
      name: 'My chat',
      providerName: 'OpenAI compatible',
      keyHint: '1234',
      reasoning: true,
      dimensions: null,
    });
    // An embedding model is measured when it's added.
    const embedder = await add({
      kind: 'embedding',
      providerId: 'openai-compatible',
      modelId: 'embed-1',
      settings: { baseURL, apiKey: GOOD_KEY },
    });
    expect(embedder.json()).toMatchObject({ kind: 'embedding', name: 'embed-1', dimensions: 3 });

    const [stored] = await client.db.select().from(userModelsTable).limit(1);
    expect(stored!.credentials).not.toContain(GOOD_KEY);
    expect(stored!.credentials).toMatch(/^v1\./);
    const listed = await app.inject({ url: '/llm/user-models?kind=llm', headers: as() });
    expect(listed.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(listed.body).not.toContain(GOOD_KEY);
  });

  it('keeps saved secrets when the form leaves them blank, and only re-checks on a change', async () => {
    const { items } = (await app.inject({ url: '/llm/user-models?kind=llm', headers: as() })).json<{
      items: { id: string }[];
    }>();
    const id = items[0]!.id;
    const edit = (payload: Record<string, unknown>, who = 'alice') =>
      app.inject({ method: 'PATCH', url: `/llm/user-models/${id}`, headers: as(who), payload });

    calls.length = 0;
    const renamed = await edit({ name: 'Renamed', settings: { apiKey: '' } });
    expect(renamed.json()).toMatchObject({ name: 'Renamed', keyHint: '1234' });
    expect(calls).toEqual([]);

    const wrong = await edit({ settings: { apiKey: 'sk-wrong-key-000000' } });
    expect(wrong.statusCode).toBe(400);
    expect(calls).toEqual(['POST /v1/chat/completions']);

    // Someone else's model is invisible to them.
    expect((await edit({ name: 'x' }, 'bob')).statusCode).toBe(404);
    const gone = await app.inject({
      method: 'DELETE',
      url: `/llm/user-models/${id}`,
      headers: as('bob'),
    });
    expect(gone.statusCode).toBe(404);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/llm/user-models/${id}`,
      headers: as(),
    });
    expect(removed.statusCode).toBe(204);
    const left = await app.inject({ url: '/llm/user-models', headers: as() });
    expect(left.json<{ items: { kind: string }[] }>().items.map((m) => m.kind)).toEqual([
      'embedding',
    ]);
  });
});
