import { randomBytes } from 'node:crypto';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import type { HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { migrateIdentity } from './db/migrate';
import { createAuthDeps } from './wiring';

const logger = createLogger({ service: 'test', level: 'silent' });

let pg: TestPostgres;
let client: PgClient;
let app: HttpServer;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 4 });
  await migrateIdentity(client, logger);
  app = buildApp({
    logger,
    pingDatabase: client.ping,
    routes: createAuthDeps(client, randomBytes(32), logger),
  });
});

afterAll(async () => {
  await app.close();
  await client.close();
  await pg.stop();
});

const password = 'correct-horse-battery';

async function register(email: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, name: 'Abhishek', password },
  });
}

interface Session {
  user: { id: string; email: string };
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
}

describe('auth routes', () => {
  it('registers a user, normalising the email', async () => {
    const res = await register('  New.User@OneBox.dev ');
    expect(res.statusCode).toBe(201);
    const body = res.json<Session>();
    expect(body.user.email).toBe('new.user@onebox.dev');
    expect(body.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('rejects a duplicate email with 409', async () => {
    await register('dup@onebox.dev');
    const res = await register('DUP@onebox.dev');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'EMAIL_TAKEN' } });
  });

  it('rejects a weak password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'weak@onebox.dev', name: 'W', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('gives the same error for unknown email and wrong password', async () => {
    await register('login@onebox.dev');
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login@onebox.dev', password: 'nope-nope-nope' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ghost@onebox.dev', password },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('logs in and reads the profile with the access token', async () => {
    await register('me@onebox.dev');
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ME@onebox.dev', password },
    });
    const { tokens } = login.json<Session>();

    const me = await app.inject({
      url: '/auth/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'me@onebox.dev', name: 'Abhishek' });
  });

  it('requires a token for /auth/me', async () => {
    expect((await app.inject({ url: '/auth/me' })).statusCode).toBe(401);
  });

  it('refreshes, and logout ends the session', async () => {
    const { tokens } = (await register('refresh@onebox.dev')).json<Session>();

    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const next = refreshed.json<Session>().tokens.refreshToken;
    expect(next).not.toBe(tokens.refreshToken);

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: next },
    });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: next },
    });
    expect(after.statusCode).toBe(401);
  });

  it('publishes a cacheable JWKS without private material', async () => {
    const res = await app.inject({ url: '/.well-known/jwks.json' });
    const { keys } = res.json<{ keys: Record<string, unknown>[] }>();
    expect(res.headers['cache-control']).toContain('max-age');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(keys[0]).not.toHaveProperty('d');
  });
});
