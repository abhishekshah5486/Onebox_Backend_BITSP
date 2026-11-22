import { randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { ValidationError } from '@onebox/errors';
import { createLogger } from '@onebox/logger';
import {
  startPgvector,
  startPostgres,
  startQdrant,
  type TestPostgres,
  type TestService,
  type TestVectorStore,
} from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { migrateSettings } from '../db/migrate';
import { indexingStores } from '../db/schema';
import { checkStore, createIndexingStorage, type ConnectionCheck } from './indexing-storage';

const logger = createLogger({ service: 'test', level: 'silent' });
const KEY = 'qdrant-key-abcdef1234';
const verifyToken: TokenVerifier = async (token) => ({ userId: token, email: 'x@onebox.dev' });

let pg: TestPostgres;
let qdrant: TestService;
let pgvector: TestVectorStore;
let client: PgClient;
const notifySearch = vi.fn(async (_userId: string) => {});
// The real check against real stores, except for one key standing in for one Qdrant rejects.
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
  [pg, qdrant, pgvector] = await Promise.all([startPostgres(), startQdrant(), startPgvector()]);
  client = createPgClient(pg.url);
  await migrateSettings(client, logger);
  check.mockImplementation(async (provider, settings) => {
    if (settings.apiKey === 'wrong-key-0000000') {
      throw new ValidationError('Qdrant: The store rejected these credentials');
    }
    await checkStore(provider, settings);
  });
}, 300_000);

afterAll(async () => {
  await client?.close();
  await Promise.all([pg?.stop(), qdrant?.stop(), pgvector?.stop()]);
});

describe('indexing storage', () => {
  const app = () => build(true);
  const call = (
    userId: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    app().inject({
      method,
      url: `/settings/indexing-storage${url}`,
      headers: { authorization: `Bearer ${userId}` },
      ...(payload && { payload }),
    });
  const internal = (userId: string) =>
    app().inject({
      url: `/internal/indexing-storage/${userId}`,
      headers: { 'x-onebox-internal-token': 'internal' },
    });
  type Listed = {
    searchStoreId: string;
    stores: { id: string; name: string; provider: string; paused: boolean; search: boolean }[];
  };

  it('lists the vector databases it can use, with the fields each asks for', async () => {
    const response = await call(randomUUID(), 'GET', '/stores');
    const { stores } = response.json<{ stores: { id: string; fields: { key: string }[] }[] }>();
    expect(stores.map((store) => store.id)).toEqual(
      expect.arrayContaining(['QDRANT', 'PINECONE', 'PGVECTOR', 'NEO4J', 'MONGODB_ATLAS']),
    );
    expect(stores.find((store) => store.id === 'NEO4J')?.fields.map((f) => f.key)).toContain(
      'password',
    );
  });

  it('keeps any number of stores, several of one kind too, each paused or not', async () => {
    const userId = randomUUID();
    expect((await call(userId, 'GET', '')).json()).toEqual({
      searchStoreId: 'onebox',
      stores: [
        { id: 'onebox', name: 'OneBox hosted', provider: 'ONEBOX', paused: false, search: true },
      ],
    });

    const first = await call(userId, 'POST', '', {
      provider: 'QDRANT',
      settings: { url: `${qdrant.url}/`, apiKey: KEY },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      name: 'Qdrant',
      settings: { url: qdrant.url },
      keyHint: '1234',
      paused: false,
      search: false,
    });
    expect(first.body).not.toContain(KEY);
    const second = await call(userId, 'POST', '', {
      provider: 'QDRANT',
      name: 'Backup',
      settings: { url: qdrant.url },
    });
    const third = await call(userId, 'POST', '', {
      provider: 'QDRANT',
      settings: { url: qdrant.url },
    });
    expect(third.json<{ name: string }>().name).toBe('Qdrant 3');
    const ids = [first, second, third].map((response) => response.json<{ id: string }>().id);
    expect(notifySearch).toHaveBeenCalledWith(userId);

    // Secrets are stored encrypted, and handed only to search, with every store.
    const rows = await client.db.select().from(indexingStores);
    expect(rows.find((row) => row.id === ids[0])!.secretsEncrypted).not.toContain(KEY);
    expect((await internal(userId)).json()).toEqual({
      searchStoreId: 'onebox',
      stores: [
        { id: 'onebox', provider: 'ONEBOX', paused: false },
        {
          id: ids[0],
          provider: 'QDRANT',
          paused: false,
          settings: { url: qdrant.url, apiKey: KEY },
        },
        { id: ids[1], provider: 'QDRANT', paused: false, settings: { url: qdrant.url } },
        { id: ids[2], provider: 'QDRANT', paused: false, settings: { url: qdrant.url } },
      ],
    });
    expect((await app().inject({ url: `/internal/indexing-storage/${userId}` })).statusCode).toBe(
      401,
    );

    // Pausing and resuming, OneBox's own too once searches go elsewhere.
    expect((await call(userId, 'PATCH', '/onebox', { paused: true })).statusCode).toBe(400);
    await call(userId, 'PUT', '/search', { storeId: ids[0] });
    await call(userId, 'PATCH', `/${ids[1]}`, { paused: true });
    const listed = (await call(userId, 'PATCH', '/onebox', { paused: true })).json<Listed>();
    expect(listed.stores.map((store) => [store.name, store.paused])).toEqual([
      ['OneBox hosted', true],
      ['Qdrant', false],
      ['Backup', true],
      ['Qdrant 3', false],
    ]);

    // A blank key keeps the saved one at the same address.
    check.mockClear();
    await call(userId, 'PATCH', `/${ids[0]}`, { settings: { url: qdrant.url, apiKey: '' } });
    expect(check).toHaveBeenCalledWith('QDRANT', { url: qdrant.url, apiKey: KEY });

    // Searches go to one store, which is resumed and can't be paused while it serves them.
    const chosen = (await call(userId, 'PUT', '/search', { storeId: ids[1] })).json<Listed>();
    expect(chosen.searchStoreId).toBe(ids[1]);
    expect(chosen.stores.find((store) => store.id === ids[1])).toMatchObject({
      paused: false,
      search: true,
    });
    const refused = await call(userId, 'PATCH', `/${ids[1]}`, { paused: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(/search/);

    // Removing the search store hands searches back to OneBox, resumed.
    expect((await call(userId, 'DELETE', `/${ids[1]}`)).statusCode).toBe(204);
    const after = (await call(userId, 'GET', '')).json<Listed>();
    expect(after.searchStoreId).toBe('onebox');
    expect(after.stores.map((store) => store.id)).toEqual(['onebox', ids[0], ids[2]]);
    expect(after.stores[0]).toMatchObject({ paused: false, search: true });
    expect((await call(userId, 'DELETE', '/onebox')).statusCode).toBe(400);
    expect((await call(randomUUID(), 'DELETE', `/${ids[0]}`)).statusCode).toBe(404);
  });

  it('connects other databases too, here Postgres with pgvector', async () => {
    const userId = randomUUID();
    const connectionString = pgvector.settings.connectionString!;
    const saved = await call(userId, 'POST', '', {
      provider: 'PGVECTOR',
      settings: { connectionString },
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.body).not.toContain(connectionString);
    // Plain Postgres has no pgvector.
    const plain = await call(userId, 'POST', '', {
      provider: 'PGVECTOR',
      settings: { connectionString: pg.url },
    });
    expect(plain.statusCode).toBe(400);
    expect(plain.json<{ error: { message: string } }>().error.message).toMatch(/pgvector/);
  });

  it('refuses what it cannot use, and saves nothing', async () => {
    const userId = randomUUID();
    const error = async (payload: Record<string, unknown>, allowPrivate = true) => {
      const response = await build(allowPrivate).inject({
        method: 'POST',
        url: '/settings/indexing-storage',
        headers: { authorization: `Bearer ${userId}` },
        payload,
      });
      expect(response.statusCode).toBe(400);
      return response.json<{ error: { message: string } }>().error.message;
    };
    const qdrantAt = (url: string, apiKey?: string) => ({
      provider: 'QDRANT',
      settings: { url, ...(apiKey && { apiKey }) },
    });
    expect(await error(qdrantAt(qdrant.url, 'wrong-key-0000000'))).toBe(
      'Qdrant: The store rejected these credentials',
    );
    expect(await error(qdrantAt('http://127.0.0.1:59999'))).toBe(
      "Qdrant: Couldn't reach the store",
    );
    expect(await error({ provider: 'NEO4J', settings: { url: 'bolt://example.com' } })).toMatch(
      /Password/i,
    );
    expect(await error(qdrantAt(qdrant.url), false)).toMatch(/private network/);
    expect(
      await error(
        {
          provider: 'MONGODB_ATLAS',
          settings: { connectionString: 'mongodb://a:b@10.0.0.1,localhost/x' },
        },
        false,
      ),
    ).toMatch(/private network/);
    const rows = await client.db.select().from(indexingStores);
    expect(rows.some((row) => row.userId === userId)).toBe(false);
  });

  it("doesn't fail a save when search can't be told", async () => {
    notifySearch.mockRejectedValueOnce(new Error('search down'));
    const saved = await call(randomUUID(), 'POST', '', {
      provider: 'QDRANT',
      settings: { url: qdrant.url },
    });
    expect(saved.statusCode).toBe(201);
  });
});
