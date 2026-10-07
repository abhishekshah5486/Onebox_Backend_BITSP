import { randomBytes, randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import type { HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { migrateAccounts } from '../db/migrate';
import { createAccountService } from './account-service';

const logger = createLogger({ service: 'test', level: 'silent' });
const internal = { [INTERNAL_TOKEN_HEADER]: 'internal-secret' };
const verifyToken: TokenVerifier = async (token) => ({
  userId: token.slice(5),
  email: 'x@onebox.dev',
});

let pg: TestPostgres;
let client: PgClient;
let app: HttpServer;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 4 });
  await migrateAccounts(client, logger);
  const accounts = createAccountService({
    db: client.db,
    encryptionKey: randomBytes(32),
    verifyImap: async () => ({ ok: true }),
    logger,
  });
  app = buildApp({
    logger,
    pingDatabase: client.ping,
    routes: { accounts, verifyToken, internalToken: 'internal-secret' },
  });
});

afterAll(async () => {
  await app.close();
  await client.close();
  await pg.stop();
});

async function connect(userId = randomUUID()) {
  const res = await app.inject({
    method: 'POST',
    url: '/accounts',
    headers: { authorization: `Bearer user-${userId}` },
    payload: { provider: 'GMAIL', emailAddress: `${randomUUID()}@gmail.com`, password: 'app-pass' },
  });
  return { id: res.json<{ id: string }>().id, userId };
}

describe('internal accounts api', () => {
  it('rejects callers without the internal token, even with a user token', async () => {
    const { id, userId } = await connect();
    for (const headers of [
      {},
      { authorization: `Bearer user-${userId}` },
      { [INTERNAL_TOKEN_HEADER]: 'nope' },
    ]) {
      const res = await app.inject({ url: `/internal/accounts/${id}/credentials`, headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it('returns decrypted credentials to internal callers', async () => {
    const { id, userId } = await connect();
    const res = await app.inject({
      url: `/internal/accounts/${id}/credentials`,
      headers: internal,
    });
    expect(res.json()).toMatchObject({
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      password: 'app-pass',
      userId,
    });
  });

  it('lists only active accounts, without secrets', async () => {
    const active = await connect();
    const paused = await connect();
    await app.inject({
      method: 'PATCH',
      url: `/accounts/${paused.id}`,
      headers: { authorization: `Bearer user-${paused.userId}` },
      payload: { enabled: false },
    });

    const res = await app.inject({ url: '/internal/accounts', headers: internal });
    const ids = res.json<{ items: { id: string }[] }>().items.map((item) => item.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(paused.id);
    expect(res.body).not.toContain('app-pass');
  });

  it('stores sync state per folder, including folder names with special characters', async () => {
    const { id } = await connect();
    const put = (folder: string, state: object) =>
      app.inject({
        method: 'PUT',
        url: `/internal/accounts/${id}/sync-state`,
        headers: internal,
        payload: { folder, state },
      });

    expect((await put('INBOX', { uidValidity: 1, lastUid: 10 })).statusCode).toBe(204);
    await put('[Gmail]/Sent Mail', { uidValidity: 7, lastUid: 3 });
    await put('INBOX', { uidValidity: 1, lastUid: 25 });

    const res = await app.inject({ url: '/internal/accounts', headers: internal });
    const account = res
      .json<{ items: { id: string; syncState: unknown }[] }>()
      .items.find((a) => a.id === id);
    expect(account?.syncState).toEqual({
      INBOX: { uidValidity: 1, lastUid: 25 },
      '[Gmail]/Sent Mail': { uidValidity: 7, lastUid: 3 },
    });
  });

  it('records connector status reports but never resumes a paused account', async () => {
    const { id, userId } = await connect();
    const report = () =>
      app.inject({
        method: 'PUT',
        url: `/internal/accounts/${id}/status`,
        headers: internal,
        payload: { status: 'AUTH_FAILED', lastError: 'Gmail rejected the sign-in' },
      });
    const read = async () =>
      (
        await app.inject({
          url: `/accounts/${id}`,
          headers: { authorization: `Bearer user-${userId}` },
        })
      ).json<{
        status: string;
        lastError: string | null;
      }>();

    await report();
    expect(await read()).toMatchObject({
      status: 'AUTH_FAILED',
      lastError: 'Gmail rejected the sign-in',
    });

    await app.inject({
      method: 'PATCH',
      url: `/accounts/${id}`,
      headers: { authorization: `Bearer user-${userId}` },
      payload: { enabled: false },
    });
    await report();
    expect((await read()).status).toBe('DISABLED');
  });
});
