import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, startRedis, type TestPostgres, type TestRedis } from '@onebox/testing';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateLlm } from '../db/migrate';
import { llmCalls } from '../db/schema';
import { createBreaker } from '../llm/breaker';
import type { Billing } from '../llm/billing';
import { createCatalog } from '../llm/catalog';
import { createCompleter } from '../llm/complete';
import type { ProviderAdapter } from '../providers/types';
import { CUSTOM_PROVIDER } from './directory';
import { createUserModels, type UserModels } from './user-models';

const logger = createLogger({ service: 'test', level: 'silent' });
const KEY = 'sk-own-key-123456';

// The user's own OpenAI-compatible server; `ownReply` decides what it answers.
let ownReply: () => { status: number; text: string } = () => ({ status: 200, text: '' });
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
  req.on('end', () => {
    const { status, text } = ownReply();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'c',
        created: 0,
        model: 'mine',
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
      }),
    );
  });
});

// OneBox's own models, all answering.
const hosted: ProviderAdapter = {
  checkKey: async () => true,
  complete: async () => ({
    text: '{"labels":["Hosted"]}',
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }),
};
const charges: string[] = [];
const broke = new Set<string>();
const billing: Billing = {
  allowed: async (userId) => !broke.has(userId),
  charge: async (userId) => void charges.push(userId),
};
const schema = {
  name: 'labels',
  schema: {
    type: 'object',
    properties: { labels: { type: 'array', items: { type: 'string' } } },
    required: ['labels'],
  },
};

let pg: TestPostgres;
let redisContainer: TestRedis;
let client: PgClient;
let redis: Redis;
let userModels: UserModels;
let baseURL: string;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([startPostgres(), startRedis()]);
  client = createPgClient(pg.url);
  await migrateLlm(client, logger);
  redis = new Redis(redisContainer.url);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  userModels = createUserModels({
    db: client.db,
    encryptionKey: Buffer.alloc(32, 3),
    directory: { provider: async (id) => (id === CUSTOM_PROVIDER.id ? CUSTOM_PROVIDER : null) },
    allowPrivateUrls: true,
    timeoutMs: 5_000,
    logger,
  });
}, 120_000);

beforeEach(async () => {
  charges.length = 0;
  broke.clear();
  await redis.flushall();
  ownReply = () => ({ status: 200, text: 'OK' });
});

afterAll(async () => {
  server.close();
  redis.disconnect();
  await client.close();
  await Promise.all([pg.stop(), redisContainer.stop()]);
});

const setup = () => {
  const catalog = createCatalog(client.db, new Set(['OPENAI', 'GEMINI'] as const), (userId, id) =>
    userModels.owns(userId, id, 'llm'),
  );
  const complete = createCompleter({
    db: client.db,
    redis,
    catalog,
    breaker: createBreaker(redis),
    adapters: { OPENAI: hosted, GEMINI: hosted },
    logger,
    cacheTtlSeconds: 0,
    timeoutMs: 5_000,
    billing,
    userModels,
  });
  return { catalog, complete };
};

async function userWithOwnModel() {
  const userId = randomUUID();
  const own = await userModels.add(userId, {
    kind: 'llm',
    providerId: CUSTOM_PROVIDER.id,
    modelId: 'mine',
    settings: { baseURL, apiKey: KEY },
  });
  await setup().catalog.choose(userId, 'classify', `user:${own.id}`);
  return { userId, ownId: `user:${own.id}`, rowId: own.id };
}

const ask = (userId: string) =>
  setup().complete({
    userId,
    purpose: 'classify',
    messages: [{ role: 'user', content: `Mail ${randomUUID()}` }],
    schema,
  });

describe("a user's own model", () => {
  it('answers their AI features, at no cost in credits', async () => {
    const { userId, ownId } = await userWithOwnModel();
    ownReply = () => ({ status: 200, text: '```json\n{"labels":["Own"]}\n```' });
    const result = await ask(userId);
    expect(result).toMatchObject({
      output: { labels: ['Own'] },
      model: ownId,
      provider: 'openai-compatible',
      usage: { inputTokens: 50, outputTokens: 5, costUsd: 0 },
    });
    expect(charges).toEqual([]);
    const [logged] = await client.db.select().from(llmCalls).where(eq(llmCalls.userId, userId));
    expect(logged).toMatchObject({ modelUsed: ownId, provider: null, status: 'ok', costUsd: 0 });
  });

  it("falls back to OneBox's models when it fails, charging only for those", async () => {
    const { userId, ownId } = await userWithOwnModel();
    ownReply = () => ({ status: 500, text: '' });
    const result = await ask(userId);
    expect(result.output).toEqual({ labels: ['Hosted'] });
    expect(result.attempts[0]).toMatchObject({ model: ownId, outcome: 'error' });
    expect(charges).toEqual([userId]);
  });

  it('still works without credits, which only stop the fallback', async () => {
    const { userId } = await userWithOwnModel();
    broke.add(userId);
    ownReply = () => ({ status: 200, text: '{"labels":["Own"]}' });
    expect((await ask(userId)).output).toEqual({ labels: ['Own'] });
    ownReply = () => ({ status: 500, text: '' });
    await expect(ask(userId)).rejects.toThrow(/could answer/);
  });

  it("can't be picked by anyone else, and removing it puts features back on Auto", async () => {
    const { userId, ownId, rowId } = await userWithOwnModel();
    const { catalog } = setup();
    await expect(catalog.choose(randomUUID(), 'classify', ownId)).rejects.toThrow(/Unknown model/);
    expect(await catalog.choiceOf(userId, 'classify')).toBe(ownId);
    await userModels.remove(userId, rowId);
    expect(await catalog.choiceOf(userId, 'classify')).toBe('auto');
  });
});
