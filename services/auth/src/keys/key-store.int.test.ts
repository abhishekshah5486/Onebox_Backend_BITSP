import { randomBytes } from 'node:crypto';
import { DecryptionError } from '@onebox/crypto';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { CompactSign, compactVerify, createLocalJWKSet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateIdentity } from '../db/migrate';
import { signingKeys } from '../db/schema';
import { createKeyStore } from './key-store';

const logger = createLogger({ service: 'test', level: 'silent' });
const encryptionKey = randomBytes(32);

let pg: TestPostgres;
let client: PgClient;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 2 });
  await migrateIdentity(client, logger);
});

afterAll(async () => {
  await client.close();
  await pg.stop();
});

describe('key store', () => {
  it('generates one key, then reuses it across instances', async () => {
    const first = await createKeyStore({ db: client.db, encryptionKey, logger }).getActiveKey();
    const second = await createKeyStore({ db: client.db, encryptionKey, logger }).getActiveKey();

    expect(second.kid).toBe(first.kid);
    expect(await client.db.select().from(signingKeys)).toHaveLength(1);
  });

  it('stores the private key encrypted', async () => {
    const [row] = await client.db.select().from(signingKeys);
    expect(row!.privateJwkEncrypted).toMatch(/^v1\./);
    expect(row!.privateJwkEncrypted).not.toContain('"d"');
    expect(row!.publicJwk).not.toHaveProperty('d');
  });

  it('publishes a JWKS that verifies signatures from the active key', async () => {
    const store = createKeyStore({ db: client.db, encryptionKey, logger });
    const { kid, privateKey } = await store.getActiveKey();
    const jws = await new CompactSign(new TextEncoder().encode('payload'))
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .sign(privateKey);

    const jwks = createLocalJWKSet(await store.getPublicJwks());
    const { payload } = await compactVerify(jws, jwks);
    expect(new TextDecoder().decode(payload)).toBe('payload');
  });

  it('refuses to load keys with the wrong encryption key', async () => {
    const store = createKeyStore({ db: client.db, encryptionKey: randomBytes(32), logger });
    await expect(store.getActiveKey()).rejects.toThrow(DecryptionError);
  });
});
