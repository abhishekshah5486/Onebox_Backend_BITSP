import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TokenVerifier } from '@onebox/auth-kit';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { UnauthorizedError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import type { safeFetch } from '@onebox/net-guard';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { migrateSettings } from './db/migrate';
import { integrations as integrationsTable, storageAccounts } from './db/schema';
import { googleDrive } from './storage/google-drive';
import { oneDrive } from './storage/onedrive';
import { createStorageService } from './storage/storage-service';
import { createIntegrationService } from './integrations/integration-service';
import { verifyWebhookSignature } from './integrations/signing';
import { createPreferencesService } from './preferences/preferences-service';

const logger = createLogger({ service: 'test', level: 'silent' });
// Assembled at runtime so secret scanners do not mistake the fake URL for a real one.
const SLACK_URL = [
  'https://hooks.slack.com/services',
  'T0TEST123',
  'B0TEST456',
  'fakeTokenForTestsUVWX',
].join('/');

const verifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith('user-')) throw new UnauthorizedError('Invalid access token');
  return { userId: token.slice(5), email: 'x@onebox.dev' };
};

let pg: TestPostgres;
let client: PgClient;
let app: HttpServer;
let strictApp: HttpServer;
let receiver: Server;
let receiverUrl: string;
let receiverStatus = 200;
const deliveries: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
const slackSend = vi.fn<typeof safeFetch>();
const googleFetch = vi.fn<typeof fetch>();

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 4 });
  await migrateSettings(client, logger);

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      deliveries.push({ headers: req.headers, body });
      res.writeHead(receiverStatus).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/onebox?token=hidden`;

  const build = (allowPrivateHosts: boolean) =>
    buildApp({
      logger,
      pingDatabase: client.ping,
      routes: {
        preferences: createPreferencesService({ db: client.db, logger }),
        integrations: createIntegrationService({
          db: client.db,
          encryptionKey: randomBytes(32),
          logger,
          allowPrivateHosts,
          maxPerUser: 4,
          send: (url, init) =>
            url.startsWith('https://hooks.slack.com')
              ? slackSend(url, init)
              : import('@onebox/net-guard').then((m) => m.safeFetch(url, init)),
        }),
        storage: createStorageService({
          db: client.db,
          encryptionKey: randomBytes(32),
          logger,
          providers: {
            GOOGLE_DRIVE: googleDrive(
              { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://gw/callback' },
              logger,
              googleFetch,
            ),
            ONEDRIVE: oneDrive(
              { clientId: 'mid', clientSecret: 'msecret', redirectUri: 'http://gw/ms' },
              logger,
              googleFetch,
            ),
          },
        }),
        verifyToken,
        internalToken: 'internal-secret',
      },
    });
  app = build(true);
  strictApp = build(false);
});

beforeEach(() => {
  receiverStatus = 200;
  slackSend.mockReset();
  slackSend.mockResolvedValue({ status: 200, ok: true, body: 'ok' });
});

afterAll(async () => {
  await Promise.all([app.close(), strictApp.close()]);
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await client.close();
  await pg.stop();
});

const as = (userId: string) => ({ authorization: `Bearer user-${userId}` });

interface Integration {
  id: string;
  target: string;
  secret?: string;
  events: string[];
  lastTestOk: boolean | null;
}

const createSlack = (userId: string, name = 'Sales alerts') =>
  app.inject({
    method: 'POST',
    url: '/settings/integrations',
    headers: as(userId),
    payload: { type: 'SLACK', name, webhookUrl: SLACK_URL },
  });

const createWebhook = (userId: string, target = receiverUrl) =>
  app.inject({
    method: 'POST',
    url: '/settings/integrations',
    headers: as(userId),
    payload: {
      type: 'WEBHOOK',
      name: 'CRM',
      url: target,
      events: ['email.interested', 'email.classified'],
    },
  });

describe('preferences', () => {
  it('requires authentication', async () => {
    expect((await app.inject({ url: '/settings/preferences' })).statusCode).toBe(401);
  });

  it('returns defaults before anything is saved', async () => {
    const res = await app.inject({ url: '/settings/preferences', headers: as(randomUUID()) });
    expect(res.json()).toEqual({
      markSeenOnFetch: true,
      autonomyMode: 'MANUAL',
      signature: null,
      timezone: 'UTC',
      sidebarHidden: [
        'category:social',
        'category:updates',
        'category:forums',
        'category:promotions',
      ],
      chipsHidden: [],
      inboxTabs: ['promotions', 'social', 'updates', 'forums'],
      updatedAt: null,
    });
  });

  it('applies partial updates and keeps other fields', async () => {
    const userId = randomUUID();
    const patch = (payload: object) =>
      app.inject({ method: 'PATCH', url: '/settings/preferences', headers: as(userId), payload });

    await patch({ markSeenOnFetch: false, timezone: 'Asia/Kolkata' });
    await patch({ sidebarHidden: ['spam'], inboxTabs: ['promotions'] });
    const res = await patch({ autonomyMode: 'SEMI', signature: '— Abhishek' });

    expect(res.json()).toMatchObject({
      sidebarHidden: ['spam'],
      inboxTabs: ['promotions'],
      markSeenOnFetch: false,
      autonomyMode: 'SEMI',
      signature: '— Abhishek',
      timezone: 'Asia/Kolkata',
    });
  });

  it.each([
    [{ timezone: 'Mars/Olympus' }],
    [{ autonomyMode: 'YOLO' }],
    [{ inboxTabs: ['primary'] }],
    [{}],
  ])('rejects %j', async (payload) => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/preferences',
      headers: as(randomUUID()),
      payload,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('internal preferences', () => {
  it('returns a user preferences only with the internal token', async () => {
    const userId = randomUUID();
    await app.inject({
      method: 'PATCH',
      url: '/settings/preferences',
      headers: as(userId),
      payload: { markSeenOnFetch: false },
    });

    const denied = await app.inject({
      url: `/internal/preferences/${userId}`,
      headers: as(userId),
    });
    expect(denied.statusCode).toBe(401);

    const res = await app.inject({
      url: `/internal/preferences/${userId}`,
      headers: { 'x-onebox-internal-token': 'internal-secret' },
    });
    expect(res.json()).toMatchObject({ markSeenOnFetch: false });
  });
});

describe('integrations', () => {
  it('creates a slack integration with a masked target and default events', async () => {
    const res = await createSlack(randomUUID());
    expect(res.statusCode).toBe(201);
    const body = res.json<Integration>();
    expect(body).toMatchObject({
      target: 'hooks.slack.com/services/T0TEST123/…/…UVWX',
      events: ['email.interested'],
    });
    expect(body).not.toHaveProperty('secret');
    expect(res.body).not.toContain('fakeToken');
  });

  it('rejects urls that are not slack incoming webhooks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/settings/integrations',
      headers: as(randomUUID()),
      payload: { type: 'SLACK', name: 'x', webhookUrl: 'https://evil.example/services/T/B/x' },
    });
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_SLACK_WEBHOOK' } });
  });

  it('encrypts the stored config', async () => {
    const { id } = (await createSlack(randomUUID(), 'encrypted')).json<Integration>();
    const rows = await client.db.select().from(integrationsTable);
    const row = rows.find((r) => r.id === id)!;
    expect(row.configEncrypted).toMatch(/^v1\./);
    expect(row.configEncrypted).not.toContain('hooks.slack.com');
  });

  it('sends a slack test message and records success', async () => {
    const userId = randomUUID();
    const { id } = (await createSlack(userId)).json<Integration>();
    const res = await app.inject({
      method: 'POST',
      url: `/settings/integrations/${id}/test`,
      headers: as(userId),
    });

    expect(res.json()).toMatchObject({ ok: true, status: 200, integration: { lastTestOk: true } });
    const [url, init] = slackSend.mock.calls[0]!;
    expect(url).toBe(SLACK_URL);
    const { text } = JSON.parse(init!.body!) as { text: string };
    expect(text).toContain('Sales alerts');
  });

  it('returns the webhook secret once and signs test deliveries with it', async () => {
    const userId = randomUUID();
    const created = (await createWebhook(userId)).json<Integration>();
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.target).toBe(receiverUrl.split('?')[0]);

    const fetched = await app.inject({
      url: `/settings/integrations/${created.id}`,
      headers: as(userId),
    });
    expect(fetched.body).not.toContain(created.secret!);

    const test = await app.inject({
      method: 'POST',
      url: `/settings/integrations/${created.id}/test`,
      headers: as(userId),
    });
    expect(test.json()).toMatchObject({ ok: true });

    const delivery = deliveries.at(-1)!;
    expect(delivery.headers['x-onebox-event']).toBe('integration.test');
    expect(
      verifyWebhookSignature(
        created.secret!,
        delivery.body,
        delivery.headers['x-onebox-signature'] as string,
      ),
    ).toBe(true);
  });

  it('rotates the webhook secret', async () => {
    const userId = randomUUID();
    const created = (await createWebhook(userId)).json<Integration>();
    const rotated = await app.inject({
      method: 'POST',
      url: `/settings/integrations/${created.id}/rotate-secret`,
      headers: as(userId),
    });
    const { secret } = rotated.json<Integration>();
    expect(secret).toMatch(/^whsec_/);
    expect(secret).not.toBe(created.secret);

    await app.inject({
      method: 'POST',
      url: `/settings/integrations/${created.id}/test`,
      headers: as(userId),
    });
    const delivery = deliveries.at(-1)!;
    const header = delivery.headers['x-onebox-signature'] as string;
    expect(verifyWebhookSignature(secret!, delivery.body, header)).toBe(true);
    expect(verifyWebhookSignature(created.secret!, delivery.body, header)).toBe(false);
  });

  it('records a failing endpoint', async () => {
    const userId = randomUUID();
    const { id } = (await createWebhook(userId)).json<Integration>();
    receiverStatus = 500;
    const res = await app.inject({
      method: 'POST',
      url: `/settings/integrations/${id}/test`,
      headers: as(userId),
    });
    expect(res.json()).toMatchObject({
      ok: false,
      status: 500,
      integration: { lastTestOk: false, lastError: 'Endpoint responded with HTTP 500' },
    });
  });

  it('refuses private and plain-http webhook targets in production mode', async () => {
    const res = await strictApp.inject({
      method: 'POST',
      url: '/settings/integrations',
      headers: as(randomUUID()),
      payload: { type: 'WEBHOOK', name: 'x', url: 'http://169.254.169.254/latest/meta-data' },
    });
    expect(res.json()).toMatchObject({ error: { code: 'INSECURE_URL' } });

    const internal = await strictApp.inject({
      method: 'POST',
      url: '/settings/integrations',
      headers: as(randomUUID()),
      payload: { type: 'WEBHOOK', name: 'x', url: 'https://127.0.0.1/hook' },
    });
    expect(internal.json()).toMatchObject({ error: { code: 'HOST_NOT_ALLOWED' } });
  });

  it('updates name, events and enabled; rejects duplicate names', async () => {
    const userId = randomUUID();
    const { id } = (await createSlack(userId, 'one')).json<Integration>();
    await createSlack(userId, 'two');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/settings/integrations/${id}`,
      headers: as(userId),
      payload: { name: 'renamed', enabled: false, events: ['account.degraded'] },
    });
    expect(updated.json()).toMatchObject({
      name: 'renamed',
      enabled: false,
      events: ['account.degraded'],
    });

    const clash = await app.inject({
      method: 'PATCH',
      url: `/settings/integrations/${id}`,
      headers: as(userId),
      payload: { name: 'two' },
    });
    expect(clash.json()).toMatchObject({ error: { code: 'INTEGRATION_EXISTS' } });
  });

  it('isolates integrations between users and deletes them', async () => {
    const [alice, bob] = [randomUUID(), randomUUID()];
    const { id } = (await createSlack(alice)).json<Integration>();

    expect(
      (await app.inject({ url: `/settings/integrations/${id}`, headers: as(bob) })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/settings/integrations/${id}`,
          headers: as(bob),
        })
      ).statusCode,
    ).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/settings/integrations/${id}`,
      headers: as(alice),
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await app.inject({ url: '/settings/integrations', headers: as(alice) })).json(),
    ).toEqual({ items: [] });
  });

  it('enforces the per-user limit', async () => {
    const userId = randomUUID();
    for (const n of [1, 2, 3, 4]) await createSlack(userId, `slack-${n}`);
    const res = await createSlack(userId, 'slack-5');
    expect(res.json()).toMatchObject({ error: { code: 'INTEGRATION_LIMIT_REACHED' } });
  });
});

describe('cloud storage', () => {
  const user = randomUUID();
  const idToken = (email: string) =>
    ['x', Buffer.from(JSON.stringify({ email })).toString('base64url'), 'y'].join('.');
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const internal = { 'x-onebox-internal-token': 'internal-secret' };

  interface Account {
    id: string;
    provider: string;
    email: string;
    defaultPath: string;
  }
  const accounts = async () =>
    (await app.inject({ method: 'GET', url: '/settings/storage', headers: as(user) })).json<{
      providers: string[];
      accounts: Account[];
    }>();
  const startConnect = () =>
    app.inject({
      method: 'POST',
      url: '/settings/storage/connect',
      headers: as(user),
      payload: { provider: 'GOOGLE_DRIVE' },
    });

  const connect = async (email: string, accessToken: string) => {
    const res = await startConnect();
    const authUrl = new URL(res.json<{ url: string }>().url);
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    googleFetch.mockResolvedValueOnce(
      json({
        access_token: accessToken,
        expires_in: 3600,
        refresh_token: `rt-${email}`,
        scope: 'openid https://www.googleapis.com/auth/drive.file email',
        id_token: idToken(email),
      }),
    );
    const state = authUrl.searchParams.get('state')!;
    return app.inject({
      method: 'GET',
      url: `/integrations/google/callback?code=c&state=${encodeURIComponent(state)}`,
    });
  };

  it('connects several accounts, each with its own token and folder', async () => {
    googleFetch.mockClear();
    const first = await connect('me@gmail.com', 'at-1');
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('me@gmail.com is now connected');
    await connect('work@gmail.com', 'at-2');
    // Connecting the same account again refreshes it instead of adding a duplicate.
    await connect('me@gmail.com', 'at-3');

    const listed = await accounts();
    expect(listed.providers).toEqual(['GOOGLE_DRIVE', 'ONEDRIVE']);
    expect(listed.accounts.every((a) => a.provider === 'GOOGLE_DRIVE')).toBe(true);
    expect(listed.accounts.map((a) => a.email)).toEqual(['me@gmail.com', 'work@gmail.com']);
    const [me, work] = listed.accounts;

    const token = (id: string, who = user) =>
      app.inject({ method: 'GET', url: `/internal/storage/token/${who}/${id}`, headers: internal });
    expect((await token(me!.id)).json()).toEqual({ provider: 'GOOGLE_DRIVE', accessToken: 'at-3' });
    expect((await token(work!.id)).json()).toEqual({
      provider: 'GOOGLE_DRIVE',
      accessToken: 'at-2',
    });
    expect((await token(work!.id, randomUUID())).statusCode).toBe(404);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/settings/storage/${work!.id}`,
      headers: as(user),
      payload: { defaultPath: ' /OneBox// Receipts/ ' },
    });
    expect(updated.json()).toMatchObject({ defaultPath: 'OneBox/Receipts' });
  });

  it('rejects a tampered state without calling Google', async () => {
    googleFetch.mockClear();
    const res = await startConnect();
    const state = new URL(res.json<{ url: string }>().url).searchParams.get('state')!;
    const callback = await app.inject({
      method: 'GET',
      url: `/integrations/google/callback?code=c&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}`,
    });
    expect(callback.statusCode).toBe(400);
    expect(callback.body).toContain('expired');
    expect(googleFetch).not.toHaveBeenCalled();
  });

  it('disconnects one account and revokes its token', async () => {
    const [me] = (await accounts()).accounts;
    googleFetch.mockClear();
    googleFetch.mockResolvedValueOnce(json({}));
    const res = await app.inject({
      method: 'DELETE',
      url: `/settings/storage/${me!.id}`,
      headers: as(user),
    });
    expect(res.statusCode).toBe(204);
    expect(googleFetch.mock.calls[0]?.[0]).toContain('/revoke');
    expect((await accounts()).accounts.map((a) => a.email)).toEqual(['work@gmail.com']);
  });

  it('connects OneDrive and keeps the refresh token Microsoft rotates', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/settings/storage/connect',
      headers: as(user),
      payload: { provider: 'ONEDRIVE' },
    });
    const authUrl = new URL(res.json<{ url: string }>().url);
    expect(authUrl.host).toBe('login.microsoftonline.com');
    expect(authUrl.searchParams.get('scope')).toContain('Files.ReadWrite');

    // No access token with the code, so the first token request refreshes.
    googleFetch.mockResolvedValueOnce(
      json({
        refresh_token: 'ms-rt-1',
        scope: 'openid email offline_access User.Read Files.ReadWrite',
        id_token: idToken('me@outlook.com'),
      }),
    );
    const state = authUrl.searchParams.get('state')!;
    const callback = await app.inject({
      method: 'GET',
      url: `/integrations/microsoft/callback?code=c&state=${encodeURIComponent(state)}`,
    });
    expect(callback.body).toContain('me@outlook.com is now connected');
    const account = (await accounts()).accounts.find((a) => a.provider === 'ONEDRIVE')!;
    const stored = async () =>
      (await client.db.select().from(storageAccounts)).find((row) => row.id === account.id)!
        .refreshTokenEncrypted;
    const first = await stored();

    googleFetch.mockResolvedValueOnce(
      json({ access_token: 'ms-at', expires_in: 3600, refresh_token: 'ms-rt-2' }),
    );
    const token = await app.inject({
      method: 'GET',
      url: `/internal/storage/token/${user}/${account.id}`,
      headers: internal,
    });
    expect(token.json()).toEqual({ provider: 'ONEDRIVE', accessToken: 'ms-at' });
    expect(await stored()).not.toBe(first);
  });
});
