import { randomUUID } from 'node:crypto';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, startRedis, type TestPostgres, type TestRedis } from '@onebox/testing';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateLlm } from '../db/migrate';
import { llmCalls } from '../db/schema';
import { ProviderError, type ProviderAdapter, type ProviderRequest } from '../providers/types';
import { createBreaker } from './breaker';
import { createCatalog } from './catalog';
import { createCompleter } from './complete';
import { createUsage } from './usage';

const logger = createLogger({ service: 'test', level: 'silent' });
const schema = {
  name: 'labels',
  schema: {
    type: 'object',
    properties: { labels: { type: 'array', items: { type: 'string' } } },
    required: ['labels'],
  },
};

let pg: TestPostgres;
let client: PgClient;
let redisContainer: TestRedis;
let redis: Redis;
// Each fake provider answers from a per-model script; calls are recorded.
const calls: string[] = [];
let script: Record<string, (request: ProviderRequest) => string> = {};
const fake: ProviderAdapter = {
  checkKey: async () => true,
  async complete(request) {
    calls.push(request.model);
    const answer = script[request.model];
    if (!answer) throw new ProviderError('HTTP 503', 'PROVIDER_DOWN', true, 503);
    return {
      text: answer(request),
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    };
  },
};

const setup = () => {
  const catalog = createCatalog(client.db, new Set(['OPENAI', 'GEMINI'] as const));
  const complete = createCompleter({
    db: client.db,
    redis,
    catalog,
    breaker: createBreaker(redis),
    adapters: { OPENAI: fake, GEMINI: fake },
    logger,
    cacheTtlSeconds: 60,
    timeoutMs: 1000,
  });
  return { catalog, complete };
};
const ask = (userId: string, content = `Mail ${randomUUID()}`) =>
  setup().complete({
    userId,
    purpose: 'classify',
    messages: [{ role: 'user', content }],
    schema,
  });

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([startPostgres(), startRedis()]);
  client = createPgClient(pg.url);
  await migrateLlm(client, logger);
  redis = new Redis(redisContainer.url);
});

beforeEach(async () => {
  calls.length = 0;
  script = {};
  await redis.flushall();
});

afterAll(async () => {
  redis.disconnect();
  await client.close();
  await Promise.all([pg.stop(), redisContainer.stop()]);
});

describe('llm proxy', () => {
  it("uses the user's model, else falls back down its provider's list, and logs it", async () => {
    const userId = randomUUID();
    await setup().catalog.choose(userId, 'classify', 'gpt-6-astra');
    script['gpt-6-sol'] = () => '{"labels":["Leads"]}';

    const result = await ask(userId);
    expect(result).toMatchObject({
      output: { labels: ['Leads'] },
      model: 'gpt-6-sol',
      cached: false,
    });
    // Astra and 6.1 Sol were each tried twice (one retry) before 6 Sol answered.
    expect(calls).toEqual([
      'gpt-6-astra',
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6.1-sol',
      'gpt-6-sol',
    ]);

    const [row] = await client.db.select().from(llmCalls).where(eq(llmCalls.userId, userId));
    expect(row).toMatchObject({
      purpose: 'classify',
      requestedModel: 'gpt-6-astra',
      modelUsed: 'gpt-6-sol',
      provider: 'OPENAI',
      status: 'ok',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 40,
    });
    // 60 fresh input at $2, 40 cached at $0.20 and 10 output at $10 per million.
    expect(row!.costUsd).toBeCloseTo(0.000228, 9);
    expect(row!.attempts.map((a) => a.outcome)).toEqual(['error', 'error', 'error', 'error', 'ok']);
  });

  it('repairs an answer that breaks the schema, and serves repeats from the cache', async () => {
    const userId = randomUUID();
    let first = true;
    script['gemini-3.8-flash'] = () => {
      const text = first ? 'labels: Leads' : '```json\n{"labels":["Leads"]}\n```';
      first = false;
      return text;
    };

    expect((await ask(userId, 'same mail')).output).toEqual({ labels: ['Leads'] });
    expect(calls).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);
    expect(await ask(userId, 'same mail')).toMatchObject({
      cached: true,
      model: 'gemini-3.8-flash',
    });
    expect(calls).toHaveLength(2);

    const usage = await createUsage(client.db)(userId, 30);
    expect(usage.totals).toMatchObject({
      calls: 2,
      cacheHits: 1,
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 80,
    });
    expect(usage.totals.costUsd).toBeCloseTo(0.000171, 9);
    expect(usage.calls.map((call) => call.cacheHit)).toEqual([true, false]);
    expect(usage.calls.map((call) => call.fellBack)).toEqual([false, false]);
  });

  it('skips a model that keeps failing, and reports when nothing can answer', async () => {
    const userId = randomUUID();
    await expect(ask(userId)).rejects.toThrow('No language model could answer right now');

    // Three failed requests trip the breaker on Auto's first model, so it stops being tried.
    script['gpt-6-luna'] = () => '{"labels":[]}';
    await ask(userId);
    await ask(userId);
    calls.length = 0;
    expect(await ask(userId)).toMatchObject({ model: 'gpt-6-luna' });
    expect(calls).toEqual(['gpt-6-luna']);
  });
});
