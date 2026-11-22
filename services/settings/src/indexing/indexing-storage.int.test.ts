import { randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { ValidationError } from '@onebox/errors';
import { createLogger } from '@onebox/logger';
import { startPostgres, startQdrant, type TestPostgres, type TestService } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { migrateSettings } from '../db/migrate';
import { indexingStores } from '../db/schema';
import { createIndexingStorage, type ConnectionCheck } from './indexing-storage';

const logger = createLogger({ service: 'test', level: 'silent' });
const KEY = 'qdrant-key-abcdef1234';
const verifyToken: TokenVerifier = async (token) => ({ userId: token, email: 'x@onebox.dev' });

let pg: TestPostgres;
let qdrant: TestService;
let client: PgClient;
const notifySearch = vi.fn(async (_userId: string) => {});
// The real check against a real Qdrant, except for one URL standing in for a key it rejects.
const check = vi.fn<ConnectionCheck>();

const build = (allowPrivateHosts: boolean) =>
  buildApp({
    logger,
    pingDatabase: client.ping,
    routes: {
      preferences: {} as never,
      integrations: {} as never,
      storage: {} as never,
      indexing: createIndexingStorage({
        db: client.db,
        encryptionKey: Buffer.alloc(32, 9),
        logger,
        allowPrivateHosts,
        check,
        notifySearch,
      }),
      verifyToken,
      internalToken: 'internal',
    },
  });

beforeAll(async () => {
  [pg, qdrant] = await Promise.all([startPostgres(), startQdrant()]);
  client = createPgClient(pg.url);
  await migrateSettings(client, logger);
  const { checkQdrant } = await import('./indexing-storage');
  check.mockImplementation(async (url, apiKey) => {
    if (apiKey === 'wrong-key-0000000') {
      throw new ValidationError('Qdrant rejected this API key', { code: 'STORE_AUTH' });
    }
    await checkQdrant(url, apiKey);
  });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await Promise.all([pg?.stop(), qdrant?.stop()]);
});

describe('indexing storage', () => {
  const app = () => build(true);
  const put = (userId: string, payload: Record<string, unknown>) =>
    app().inject({
      method: 'PUT',
      url: '/settings/indexing-storage',
      headers: { authorization: `Bearer ${userId}` },
      payload,
    });

  it("starts on OneBox's own store, and moves to the user's Qdrant once it connects", async () => {
    const userId = randomUUID();
    const auth = { authorization: `Bearer ${userId}` };
    expect(
      (await app().inject({ url: '/settings/indexing-storage', headers: auth })).json(),
    ).toEqual({
      provider: 'ONEBOX',
    });

    const saved = await put(userId, { url: `${qdrant.url}/`, apiKey: KEY });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ provider: 'QDRANT', url: qdrant.url, keyHint: '1234' });
    expect(saved.body).not.toContain(KEY);
    expect(notifySearch).toHaveBeenCalledWith(userId);

    // The key is stored encrypted, and handed only to search.
    const [row] = await client.db.select().from(indexingStores);
    expect(row!.apiKeyEncrypted).not.toContain(KEY);
    const internal = await app().inject({
      url: `/internal/indexing-storage/${userId}`,
      headers: { 'x-onebox-internal-token': 'internal' },
    });
    expect(internal.json()).toEqual({ provider: 'QDRANT', url: qdrant.url, apiKey: KEY });
    expect((await app().inject({ url: `/internal/indexing-storage/${userId}` })).statusCode).toBe(
      401,
    );

    // A blank key keeps the saved one.
    check.mockClear();
    await put(userId, { url: qdrant.url, apiKey: '' });
    expect(check).toHaveBeenCalledWith(qdrant.url, KEY);

    notifySearch.mockClear();
    const reset = await app().inject({
      method: 'DELETE',
      url: '/settings/indexing-storage',
      headers: auth,
    });
    expect(reset.statusCode).toBe(204);
    expect(notifySearch).toHaveBeenCalledWith(userId);
    expect(
      (await app().inject({ url: '/settings/indexing-storage', headers: auth })).json(),
    ).toEqual({
      provider: 'ONEBOX',
    });
  });

  it('refuses what it cannot use, and saves nothing', async () => {
    const userId = randomUUID();
    const error = async (payload: Record<string, unknown>, allowPrivate = true) => {
      const response = await build(allowPrivate).inject({
        method: 'PUT',
        url: '/settings/indexing-storage',
        headers: { authorization: `Bearer ${userId}` },
        payload,
      });
      expect(response.statusCode).toBe(400);
      return response.json<{ error: { message: string } }>().error.message;
    };
    expect(await error({ url: qdrant.url, apiKey: 'wrong-key-0000000' })).toBe(
      'Qdrant rejected this API key',
    );
    expect(await error({ url: 'http://127.0.0.1:1' })).toBe("Couldn't reach Qdrant at 127.0.0.1:1");
    expect(await error({ url: 'ftp://example.com' })).toMatch(/http/);
    expect(await error({ url: qdrant.url }, false)).toMatch(/private network/);
    const rows = await client.db.select().from(indexingStores);
    expect(rows.some((row) => row.userId === userId)).toBe(false);
  });

  it("doesn't fail a save when search can't be told", async () => {
    notifySearch.mockRejectedValueOnce(new Error('search down'));
    const saved = await put(randomUUID(), { url: qdrant.url });
    expect(saved.statusCode).toBe(200);
  });
});
