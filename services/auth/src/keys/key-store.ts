import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '@onebox/crypto';
import type { Logger } from '@onebox/logger';
import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK } from 'jose';
import { signingKeys } from '../db/schema';

export const SIGNING_ALG = 'EdDSA';

const JWKS_CACHE_MS = 60_000;

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
}

export interface KeyStoreDeps {
  db: PostgresJsDatabase;
  encryptionKey: Buffer;
  logger: Logger;
}

export function createKeyStore({ db, encryptionKey, logger }: KeyStoreDeps) {
  let active: Promise<SigningKey> | undefined;
  let jwksCache: { value: { keys: JWK[] }; expiresAt: number } | undefined;

  async function generate(): Promise<SigningKey> {
    const kid = randomUUID();
    const { publicKey, privateKey } = await generateKeyPair(SIGNING_ALG, { extractable: true });
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: SIGNING_ALG, use: 'sig' };
    const privateJwk = JSON.stringify(await exportJWK(privateKey));

    await db.insert(signingKeys).values({
      kid,
      publicJwk,
      privateJwkEncrypted: encrypt(privateJwk, encryptionKey, kid),
    });
    logger.info({ kid }, 'generated new signing key');
    return { kid, privateKey };
  }

  async function loadOrGenerate(): Promise<SigningKey> {
    const [row] = await db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.active, true))
      .orderBy(desc(signingKeys.createdAt))
      .limit(1);
    if (!row) return generate();

    const jwk = JSON.parse(decrypt(row.privateJwkEncrypted, encryptionKey, row.kid)) as JWK;
    const privateKey = (await importJWK(jwk, SIGNING_ALG)) as CryptoKey;
    logger.info({ kid: row.kid }, 'loaded signing key');
    return { kid: row.kid, privateKey };
  }

  return {
    getActiveKey(): Promise<SigningKey> {
      active ??= loadOrGenerate().catch((err: unknown) => {
        active = undefined;
        throw err;
      });
      return active;
    },

    async getPublicJwks(now = Date.now()): Promise<{ keys: JWK[] }> {
      if (jwksCache && jwksCache.expiresAt > now) return jwksCache.value;
      const rows = await db
        .select({ publicJwk: signingKeys.publicJwk })
        .from(signingKeys)
        .where(eq(signingKeys.active, true));
      const value = { keys: rows.map((row) => row.publicJwk as JWK) };
      jwksCache = { value, expiresAt: now + JWKS_CACHE_MS };
      return value;
    },
  };
}

export type KeyStore = ReturnType<typeof createKeyStore>;
