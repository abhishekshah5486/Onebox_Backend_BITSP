import { randomBytes, randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import { decrypt } from '@onebox/crypto';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { UnauthorizedError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { migrateAccounts } from '../db/migrate';
import { emailAccounts } from '../db/schema';
import type { ImapVerifier, VerifyResult } from '../imap/verify-imap';
import { createAccountService } from './account-service';

const logger = createLogger({ service: 'test', level: 'silent' });
const encryptionKey = randomBytes(32);

// Tokens in these tests are simply the user id.
const verifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith('user-')) throw new UnauthorizedError('Invalid access token');
  return { userId: token.slice(5), email: 'x@onebox.dev' };
};

const verifyImap = vi.fn<ImapVerifier>();
const authFailed: VerifyResult = {
  ok: false,
  reason: 'AUTH_FAILED',
  message: 'The mail server rejected the username or password',
};

let pg: TestPostgres;
let client: PgClient;
let app: HttpServer;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 4 });
  await migrateAccounts(client, logger);
  const accounts = createAccountService({
    db: client.db,
    encryptionKey,
    verifyImap,
    logger,
    maxAccountsPerUser: 3,
  });
  app = buildApp({
    logger,
    pingDatabase: client.ping,
    routes: { accounts, verifyToken, internalToken: 'test-internal-token' },
  });
});

beforeEach(() => {
  verifyImap.mockReset();
  verifyImap.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  await app.close();
  await client.close();
  await pg.stop();
});

const as = (userId: string) => ({ authorization: `Bearer user-${userId}` });

interface Account {
  id: string;
  status: string;
  emailAddress: string;
  imap: { host: string; port: number; tls: boolean };
  smtp: { host: string } | null;
  displayName: string | null;
}

async function createGmail(userId: string, emailAddress = 'me@gmail.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/accounts',
    headers: as(userId),
    payload: { provider: 'GMAIL', emailAddress, password: 'app-password-123' },
  });
  return res;
}

describe('accounts api', () => {
  it('requires a valid token', async () => {
    expect((await app.inject({ url: '/accounts' })).statusCode).toBe(401);
    const bad = await app.inject({ url: '/accounts', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
  });

  it('connects a gmail account using the preset and never returns the password', async () => {
    const userId = randomUUID();
    const res = await createGmail(userId, '  Me@Gmail.com ');

    expect(res.statusCode).toBe(201);
    const account = res.json<Account>();
    expect(account).toMatchObject({
      emailAddress: 'me@gmail.com',
      status: 'CONNECTED',
      imap: { host: 'imap.gmail.com', port: 993, tls: true },
      smtp: { host: 'smtp.gmail.com' },
    });
    expect(res.body).not.toContain('app-password-123');
    expect(res.body).not.toContain('credentials');
    expect(verifyImap).toHaveBeenCalledWith({
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      username: 'me@gmail.com',
      password: 'app-password-123',
    });
  });

  it('stores the password encrypted and bound to the account', async () => {
    const userId = randomUUID();
    const { id } = (await createGmail(userId)).json<Account>();
    const [row] = await client.db.select().from(emailAccounts).where(eq(emailAccounts.id, id));

    expect(row!.credentialsEncrypted).not.toContain('app-password-123');
    expect(decrypt(row!.credentialsEncrypted, encryptionKey, `account:${id}`)).toBe(
      'app-password-123',
    );
    expect(() =>
      decrypt(row!.credentialsEncrypted, encryptionKey, `account:${randomUUID()}`),
    ).toThrow();
  });

  it.each([
    ['ICLOUD', 'imap.mail.me.com'],
    ['YAHOO', 'imap.mail.yahoo.com'],
  ])('connects %s using its preset', async (provider, host) => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: as(randomUUID()),
      payload: { provider, emailAddress: 'me@example.com', password: 'app-specific' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ provider, imap: { host, port: 993, tls: true } });
  });

  it('rejects unknown providers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: as(randomUUID()),
      payload: { provider: 'AOL', emailAddress: 'me@aol.com', password: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires server settings for generic imap accounts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: as(randomUUID()),
      payload: { provider: 'IMAP', emailAddress: 'a@corp.example', password: 'pw' },
    });
    expect(res.statusCode).toBe(400);
    expect(verifyImap).not.toHaveBeenCalled();
  });

  it('connects a generic imap account with a custom username', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: as(randomUUID()),
      payload: {
        provider: 'IMAP',
        emailAddress: 'a@corp.example',
        username: 'corp\\alice',
        password: 'pw',
        imap: { host: 'Mail.Corp.Example', port: 993, tls: true },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ imap: { host: 'mail.corp.example' }, smtp: null });
    expect(verifyImap).toHaveBeenCalledWith(expect.objectContaining({ username: 'corp\\alice' }));
  });

  it('rejects credentials the mail server refuses, storing nothing', async () => {
    verifyImap.mockResolvedValue(authFailed);
    const userId = randomUUID();
    const res = await createGmail(userId);

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { code: 'CONNECTION_FAILED', details: { reason: 'AUTH_FAILED' } },
    });
    const list = await app.inject({ url: '/accounts', headers: as(userId) });
    expect(list.json()).toEqual({ items: [] });
  });

  it('rejects the same mailbox twice for one user', async () => {
    const userId = randomUUID();
    await createGmail(userId);
    const again = await createGmail(userId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'ACCOUNT_EXISTS' } });
  });

  it('enforces the per-user account limit', async () => {
    const userId = randomUUID();
    for (const n of [1, 2, 3]) await createGmail(userId, `me${n}@gmail.com`);
    const res = await createGmail(userId, 'me4@gmail.com');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'ACCOUNT_LIMIT_REACHED' } });
  });

  it('isolates accounts between users', async () => {
    const [alice, bob] = [randomUUID(), randomUUID()];
    const { id } = (await createGmail(alice)).json<Account>();

    const bobList = await app.inject({ url: '/accounts', headers: as(bob) });
    expect(bobList.json()).toEqual({ items: [] });
    for (const request of [
      { method: 'GET' as const, url: `/accounts/${id}` },
      { method: 'PATCH' as const, url: `/accounts/${id}`, payload: { displayName: 'x' } },
      { method: 'DELETE' as const, url: `/accounts/${id}` },
      { method: 'POST' as const, url: `/accounts/${id}/test` },
    ]) {
      const res = await app.inject({ ...request, headers: as(bob) });
      expect(res.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
  });

  it('renames and clears the display name', async () => {
    const userId = randomUUID();
    const { id } = (await createGmail(userId)).json<Account>();

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/accounts/${id}`,
      headers: as(userId),
      payload: { displayName: 'Personal' },
    });
    expect(renamed.json()).toMatchObject({ displayName: 'Personal' });

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/accounts/${id}`,
      headers: as(userId),
      payload: { displayName: null },
    });
    expect(cleared.json()).toMatchObject({ displayName: null });
  });

  it('rejects an empty update', async () => {
    const userId = randomUUID();
    const { id } = (await createGmail(userId)).json<Account>();
    const res = await app.inject({
      method: 'PATCH',
      url: `/accounts/${id}`,
      headers: as(userId),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('verifies a new password before storing it', async () => {
    const userId = randomUUID();
    const { id } = (await createGmail(userId)).json<Account>();
    verifyImap.mockResolvedValue(authFailed);

    const res = await app.inject({
      method: 'PATCH',
      url: `/accounts/${id}`,
      headers: as(userId),
      payload: { password: 'wrong-new-password' },
    });

    expect(res.statusCode).toBe(422);
    const [row] = await client.db.select().from(emailAccounts).where(eq(emailAccounts.id, id));
    expect(decrypt(row!.credentialsEncrypted, encryptionKey, `account:${id}`)).toBe(
      'app-password-123',
    );
  });

  it('disables and re-enables an account, re-verifying on enable', async () => {
    const userId = randomUUID();
    const { id } = (await createGmail(userId)).json<Account>();
    const patch = (enabled: boolean) =>
      app.inject({
        method: 'PATCH',
        url: `/accounts/${id}`,
        headers: as(userId),
        payload: { enabled },
      });

    expect((await patch(false)).json()).toMatchObject({ status: 'DISABLED' });

    verifyImap.mockClear();
    verifyImap.mockResolvedValue(authFailed);
    expect((await patch(true)).json()).toMatchObject({
      status: 'AUTH_FAILED',
      lastError: authFailed.message,
    });
    expect(verifyImap).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'app-password-123' }),
    );
  });

  it('re-tests a connection and records the outcome', async () => {
    const userId = randomUUID();
    const { id } = (await createGmail(userId)).json<Account>();
    verifyImap.mockResolvedValue(authFailed);

    const res = await app.inject({
      method: 'POST',
      url: `/accounts/${id}/test`,
      headers: as(userId),
    });

    expect(res.json()).toMatchObject({
      ok: false,
      reason: 'AUTH_FAILED',
      account: { status: 'AUTH_FAILED' },
    });
  });

  it('deletes an account', async () => {
    const userId = randomUUID();
    const { id } = (await createGmail(userId)).json<Account>();

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/accounts/${id}`,
      headers: as(userId),
    });
    expect(deleted.statusCode).toBe(204);
    const again = await app.inject({ url: `/accounts/${id}`, headers: as(userId) });
    expect(again.statusCode).toBe(404);
  });

  it('rejects malformed ids', async () => {
    const res = await app.inject({ url: '/accounts/not-a-uuid', headers: as(randomUUID()) });
    expect(res.statusCode).toBe(400);
  });
});
