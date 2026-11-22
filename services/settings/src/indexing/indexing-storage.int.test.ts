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
  const put = (userId: string, payload: Record<string, unknown>) =>
    app().inject({
      method: 'PUT',
      url: '/settings/indexing-storage',
      headers: { authorization: `Bearer ${userId}` },
      payload,
    });
  const internal = (userId: string) =>
    app().inject({
      url: `/internal/indexing-storage/${userId}`,
      headers: { 'x-onebox-internal-token': 'internal' },
    });

  it('lists the vector databases it can use, with the fields each asks for', async () => {
    const response = await app().inject({
      url: '/settings/indexing-storage/stores',
      headers: { authorization: `Bearer ${randomUUID()}` },
    });
    const { stores } = response.json<{ stores: { id: string; fields: { key: string }[] }[] }>();
    expect(stores.map((store) => store.id)).toEqual(
      expect.arrayContaining(['QDRANT', 'PINECONE', 'PGVECTOR', 'NEO4J', 'MONGODB_ATLAS']),
    );
    expect(stores.find((store) => store.id === 'NEO4J')?.fields.map((f) => f.key)).toContain(
      'password',
    );
  });

  it("starts on OneBox's own store, and moves to the user's Qdrant once it connects", async () => {
    const userId = randomUUID();
    const auth = { authorization: `Bearer ${userId}` };
    expect(
      (await app().inject({ url: '/settings/indexing-storage', headers: auth })).json(),
    ).toEqual({ provider: 'ONEBOX' });

    const saved = await put(userId, {
      provider: 'QDRANT',
      settings: { url: `${qdrant.url}/`, apiKey: KEY },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      provider: 'QDRANT',
      settings: { url: qdrant.url },
      keyHint: '1234',
    });
    expect(saved.body).not.toContain(KEY);
    expect(notifySearch).toHaveBeenCalledWith(userId);

    // Secrets are stored encrypted, and handed only to search.
    const [row] = await client.db.select().from(indexingStores);
    expect(row!.secretsEncrypted).not.toContain(KEY);
    expect((await internal(userId)).json()).toEqual({
      provider: 'QDRANT',
      settings: { url: qdrant.url, apiKey: KEY },
    });
    expect((await app().inject({ url: `/internal/indexing-storage/${userId}` })).statusCode).toBe(
      401,
    );

    // A blank key keeps the saved one at the same address.
    check.mockClear();
    await put(userId, { provider: 'QDRANT', settings: { url: qdrant.url, apiKey: '' } });
    expect(check).toHaveBeenCalledWith('QDRANT', { url: qdrant.url, apiKey: KEY });

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
    ).toEqual({ provider: 'ONEBOX' });
  });

  it('connects other databases too, here Postgres with pgvector', async () => {
    const userId = randomUUID();
    const connectionString = pgvector.settings.connectionString!;
    const saved = await put(userId, { provider: 'PGVECTOR', settings: { connectionString } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(connectionString);
    expect((await internal(userId)).json()).toEqual({
      provider: 'PGVECTOR',
      settings: { connectionString },
    });
    // Plain Postgres has no pgvector.
    const plain = await put(userId, {
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
        method: 'PUT',
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
    const saved = await put(randomUUID(), { provider: 'QDRANT', settings: { url: qdrant.url } });
    expect(saved.statusCode).toBe(200);
  });
});
