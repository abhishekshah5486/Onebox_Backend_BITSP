import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateLlm } from '../db/migrate';
import { createProviderDirectory } from './directory';
import { catalogFixture } from './fixture';

const logger = createLogger({ service: 'test', level: 'silent' });
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

const directory = (fetchFn: typeof fetch, ttlMs = 60_000) =>
  createProviderDirectory({
    db: client.db,
    url: 'https://models.dev/api.json',
    ttlMs,
    logger,
    fetchFn,
  });

describe('provider directory', () => {
  it('reads models.dev once per refresh, and falls back to its last good copy when it is down', async () => {
    const up = vi.fn(async () => Response.json(catalogFixture));
    const live = directory(up);
    const ids = (list: { id: string }[]) => list.map((provider) => provider.id);
    expect(ids(await live.providers())).toEqual([
      'amazon-bedrock',
      'fireworks-ai',
      'lmstudio',
      'openai',
      'openai-compatible',
    ]);
    await live.provider('openai');
    expect(up).toHaveBeenCalledTimes(1);

    // A fresh start while models.dev is down still lists everything, and doesn't retry each time.
    const down = vi.fn(async () => new Response('down', { status: 503 }));
    const offline = directory(down);
    expect(ids(await offline.providers())).toContain('openai');
    expect((await offline.provider('openai'))?.models.map((model) => model.id)).toEqual([
      'gpt-5',
      'text-embedding-3-small',
    ]);
    expect(down).toHaveBeenCalledTimes(1);
    expect(await offline.provider('nope')).toBeNull();
  });

  it('offers only the featured providers, in their order, yet still finds the others', async () => {
    const featured = createProviderDirectory({
      db: client.db,
      url: 'https://models.dev/api.json',
      ttlMs: 60_000,
      logger,
      featured: ['openai', 'openai-compatible', 'missing', 'amazon-bedrock'],
      fetchFn: async () => Response.json(catalogFixture),
    });
    expect((await featured.providers()).map((provider) => provider.id)).toEqual([
      'openai',
      'openai-compatible',
      'amazon-bedrock',
    ]);
    expect(await featured.provider('lmstudio')).not.toBeNull();
  });
});
