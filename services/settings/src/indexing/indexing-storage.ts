import { decrypt, encrypt } from '@onebox/crypto';
import { ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { resolvePublicHost } from '@onebox/net-guard';
import { QdrantClient } from '@qdrant/js-client-rest';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { indexingStores } from '../db/schema';

export interface StoreInput {
  url: string;
  // Blank keeps the saved key for the same URL.
  apiKey?: string | undefined;
}

export type ConnectionCheck = (url: string, apiKey: string | undefined) => Promise<void>;

// Lists collections, which needs both a reachable server and an accepted key.
export const checkQdrant: ConnectionCheck = async (url, apiKey) => {
  const client = new QdrantClient({
    url,
    ...(apiKey && { apiKey }),
    timeout: 10_000,
    checkCompatibility: false,
  });
  try {
    await client.getCollections();
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      throw new ValidationError('Qdrant rejected this API key', { code: 'STORE_AUTH' });
    }
    throw new ValidationError(`Couldn't reach Qdrant at ${new URL(url).host}`, {
      code: 'STORE_UNREACHABLE',
    });
  }
};

const hintOf = (key: string | undefined) => (key && key.length >= 12 ? key.slice(-4) : null);

// Where a user's semantic search vectors are kept: OneBox's own Qdrant, or theirs. Each change
// is checked with a real connection, and search is told so it can move the vectors there.
export function createIndexingStorage({
  db,
  encryptionKey,
  logger,
  allowPrivateHosts,
  check = checkQdrant,
  notifySearch,
}: {
  db: PostgresJsDatabase;
  encryptionKey: Buffer;
  logger: Logger;
  allowPrivateHosts: boolean;
  check?: ConnectionCheck;
  notifySearch: (userId: string) => Promise<void>;
}) {
  const aad = (userId: string) => `indexing:${userId}`;
  const find = async (userId: string) =>
    (await db.select().from(indexingStores).where(eq(indexingStores.userId, userId)))[0];

  // Search learning late is fine (it notices the change itself), so this never fails a save.
  const tellSearch = (userId: string) =>
    notifySearch(userId).catch((err: unknown) =>
      logger.warn({ userId, err: (err as Error).message }, 'search not told of storage change'),
    );

  return {
    async get(userId: string) {
      const row = await find(userId);
      if (!row) return { provider: 'ONEBOX' as const };
      return {
        provider: row.provider,
        url: row.url,
        keyHint: row.keyHint,
        updatedAt: row.updatedAt.toISOString(),
      };
    },

    // For search only: the store with its key.
    async connection(userId: string) {
      const row = await find(userId);
      if (!row) return { provider: 'ONEBOX' as const };
      return {
        provider: row.provider,
        url: row.url,
        apiKey: row.apiKeyEncrypted
          ? decrypt(row.apiKeyEncrypted, encryptionKey, aad(userId))
          : null,
      };
    },

    async set(userId: string, input: StoreInput) {
      let url: URL;
      try {
        url = new URL(input.url.trim());
      } catch {
        throw new ValidationError('Enter the Qdrant URL, e.g. https://xyz.cloud.qdrant.io:6333');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new ValidationError('The Qdrant URL must start with http:// or https://');
      }
      await resolvePublicHost(url.hostname.replace(/^\[|\]$/g, ''), {
        allowPrivate: allowPrivateHosts,
      });
      const clean = url.toString().replace(/\/$/, '');
      const existing = await find(userId);
      const typed = input.apiKey?.trim() || undefined;
      const apiKey =
        typed ??
        (existing?.url === clean && existing.apiKeyEncrypted
          ? decrypt(existing.apiKeyEncrypted, encryptionKey, aad(userId))
          : undefined);
      await check(clean, apiKey);
      const values = {
        provider: 'QDRANT' as const,
        url: clean,
        apiKeyEncrypted: apiKey ? encrypt(apiKey, encryptionKey, aad(userId)) : null,
        keyHint: hintOf(apiKey),
      };
      await db
        .insert(indexingStores)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: indexingStores.userId, set: values });
      logger.info({ userId, host: url.host }, 'indexing storage set');
      await tellSearch(userId);
      return this.get(userId);
    },

    async clear(userId: string) {
      const removed = await db
        .delete(indexingStores)
        .where(eq(indexingStores.userId, userId))
        .returning();
      if (removed.length > 0) {
        logger.info({ userId }, 'indexing storage back on onebox');
        await tellSearch(userId);
      }
    },
  };
}

export type IndexingStorage = ReturnType<typeof createIndexingStorage>;
