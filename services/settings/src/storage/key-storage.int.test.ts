import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import type { TokenVerifier } from '@onebox/auth-kit';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import {
  startAzurite,
  startPostgres,
  startS3,
  type TestAzurite,
  type TestObjectStore,
  type TestPostgres,
} from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { migrateSettings } from '../db/migrate';
import { storageAccounts } from '../db/schema';
import { createStorageService } from './storage-service';

const logger = createLogger({ service: 'test', level: 'silent' });
const verifyToken: TokenVerifier = async (token) => ({ userId: token, email: 'x@onebox.dev' });

let pg: TestPostgres;
let s3: TestObjectStore;
let azure: TestAzurite;
let client: PgClient;

const build = (allowPrivateHosts = true) =>
  buildApp({
    logger,
    pingDatabase: client.ping,
    routes: {
      preferences: {} as never,
      integrations: {} as never,
      indexing: {} as never,
      storage: createStorageService({
        db: client.db,
        encryptionKey: Buffer.alloc(32, 4),
        logger,
        providers: {},
        allowPrivateHosts,
        azureEndpoint: (account) => azure.endpoint(account),
      }),
      verifyToken,
      internalToken: 'internal',
    },
  });

beforeAll(async () => {
  [pg, s3, azure] = await Promise.all([startPostgres(), startS3(), startAzurite()]);
  client = createPgClient(pg.url);
  await migrateSettings(client, logger);
  const admin = new S3Client({
    region: 'us-east-1',
    endpoint: s3.url,
    forcePathStyle: true,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
  });
  await admin.send(new CreateBucketCommand({ Bucket: 'receipts' }));
  await new ContainerClient(
    `${azure.endpoint(azure.accountName)}/files`,
    new StorageSharedKeyCredential(azure.accountName, azure.accountKey),
  ).create();
}, 240_000);

afterAll(async () => {
  await client?.close();
  await Promise.all([pg?.stop(), s3?.stop(), azure?.stop()]);
});

const s3Body = (extra: Record<string, unknown> = {}) => ({
  provider: 'S3',
  credentials: {
    preset: 'custom',
    endpoint: s3.url,
    region: 'us-east-1',
    bucket: 'receipts',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    ...extra,
  },
});

describe('storage connected with keys', () => {
  const connect = (userId: string, payload: unknown, allowPrivate = true) =>
    build(allowPrivate).inject({
      method: 'POST',
      url: '/settings/storage/keys',
      headers: { authorization: `Bearer ${userId}` },
      payload: payload as Record<string, unknown>,
    });
  const message = (response: { json: <T>() => T }) =>
    response.json<{ error: { message: string } }>().error.message;

  it('connects a bucket after writing to it, and hands its keys only to other services', async () => {
    const userId = randomUUID();
    const connected = await connect(userId, s3Body());
    expect(connected.statusCode).toBe(201);
    expect(connected.json()).toMatchObject({ provider: 'S3', email: 'receipts (S3 compatible)' });
    expect(connected.body).not.toContain(s3.secretAccessKey);

    const [row] = await client.db.select().from(storageAccounts);
    expect(row!.refreshTokenEncrypted).not.toContain(s3.secretAccessKey);
    const token = await build().inject({
      url: `/internal/storage/token/${userId}/${row!.id}`,
      headers: { 'x-onebox-internal-token': 'internal' },
    });
    const { provider, accessToken } = token.json<{ provider: string; accessToken: string }>();
    expect(provider).toBe('S3');
    expect(JSON.parse(accessToken)).toMatchObject({
      bucket: 'receipts',
      secretAccessKey: s3.secretAccessKey,
    });

    // Connecting it again keeps one account.
    await connect(userId, s3Body());
    const list = await build().inject({
      url: '/settings/storage',
      headers: { authorization: `Bearer ${userId}` },
    });
    const body = list.json<{ providers: string[]; accounts: unknown[] }>();
    expect(body.accounts).toHaveLength(1);
    expect(body.providers).toEqual(expect.arrayContaining(['S3', 'AZURE_BLOB']));
    expect(list.json<{ s3Presets: unknown[] }>().s3Presets).toContainEqual({
      id: 'r2',
      name: 'Cloudflare R2',
      region: 'auto',
      needsAccount: true,
      needsEndpoint: false,
    });
  });

  it('connects an Azure container', async () => {
    const response = await connect(randomUUID(), {
      provider: 'AZURE_BLOB',
      credentials: {
        accountName: azure.accountName.toLowerCase().slice(0, 24),
        accountKey: azure.accountKey,
        container: 'files',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      provider: 'AZURE_BLOB',
      email: 'files (devstoreaccount1)',
    });
  });

  it('says what is wrong with keys it cannot use, saving nothing', async () => {
    const userId = randomUUID();
    expect(message(await connect(userId, s3Body({ secretAccessKey: 'wrong' })))).toBe(
      'The storage service rejected these keys',
    );
    expect(
      message(
        await connect(userId, {
          provider: 'AZURE_BLOB',
          credentials: {
            accountName: 'devstoreaccount1',
            accountKey: 'd3Jvbmc=',
            container: 'files',
          },
        }),
      ),
    ).toBe('Azure rejected this account key');
    expect(message(await connect(userId, s3Body(), false))).toMatch(/private network/);
    const rows = await client.db.select().from(storageAccounts);
    expect(rows.some((row) => row.userId === userId)).toBe(false);
  });
});
