import { resolveSrv } from 'node:dns/promises';
import {
  VECTOR_STORES,
  vectorStoreInfo,
  type VectorStoreConnection,
  type VectorStoreId,
} from '@onebox/contracts';
import { decrypt, encrypt } from '@onebox/crypto';
import { ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { resolvePublicHost } from '@onebox/net-guard';
import { checkVectorStore, StoreCheckError } from '@onebox/vector-stores';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { indexingStores } from '../db/schema';

export interface StoreInput {
  provider: VectorStoreId;
  // Secret fields left blank keep what's saved, if the store and its address haven't changed.
  settings: Record<string, string | undefined>;
}

export type ConnectionCheck = (
  provider: VectorStoreId,
  settings: Record<string, string>,
) => Promise<void>;

// A real call with the given credentials; its failure reads as a form error.
export const checkStore: ConnectionCheck = async (provider, settings) => {
  try {
    await checkVectorStore(provider, settings);
  } catch (err) {
    if (err instanceof StoreCheckError) {
      throw new ValidationError(`${vectorStoreInfo(provider).name}: ${err.message}`, {
        code: 'STORE_CHECK',
      });
    }
    throw err;
  }
};

// The hosts in an address, whatever its form: a URL, host:port, or a connection string
// with credentials and several hosts (e.g. mongodb://u:p@a:27017,b:27017/db).
export function hostsOf(address: string) {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(address)?.[1]?.toLowerCase() ?? null;
  let rest = scheme ? address.slice(scheme.length + 3) : address;
  rest = rest.split(/[/?#]/)[0]!;
  rest = rest.slice(rest.lastIndexOf('@') + 1);
  const hosts = rest
    .split(',')
    .map((part) => {
      const ipv6 = /^\[([^\]]+)\]/.exec(part)?.[1];
      return (ipv6 ?? part.split(':')[0] ?? '').trim();
    })
    .filter(Boolean);
  return { scheme, hosts };
}

const hintOf = (secrets: Record<string, string>) => {
  const longest = Object.values(secrets).sort((a, b) => b.length - a.length)[0];
  return longest && longest.length >= 12 ? longest.slice(-4) : null;
};

// Where a user's semantic search vectors are kept: OneBox's own Qdrant, or a vector database
// of theirs. Each change is checked with a real connection, and search is told so it can move
// the vectors there.
export function createIndexingStorage({
  db,
  encryptionKey,
  logger,
  allowPrivateHosts,
  check = checkStore,
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

  function secretsOf(userId: string, row: { secretsEncrypted: string | null }) {
    if (!row.secretsEncrypted) return {};
    const plain = decrypt(row.secretsEncrypted, encryptionKey, aad(userId));
    // Rows saved before other stores existed hold a bare Qdrant key.
    return plain.startsWith('{')
      ? (JSON.parse(plain) as Record<string, string>)
      : { apiKey: plain };
  }

  // Search learning late is fine (it notices the change itself), so this never fails a save.
  const tellSearch = (userId: string) =>
    notifySearch(userId).catch((err: unknown) =>
      logger.warn({ userId, err: (err as Error).message }, 'search not told of storage change'),
    );

  // Every address must lead to the public internet, unless private hosts are allowed.
  async function guard(address: string, label: string) {
    const { scheme, hosts } = hostsOf(address);
    if (!hosts.length) throw new ValidationError(`Enter the ${label}`);
    for (const host of hosts) {
      // An SRV name (Atlas) only names the real hosts; those are what get checked.
      const targets =
        scheme === 'mongodb+srv'
          ? (await resolveSrv(`_mongodb._tcp.${host}`).catch(() => [])).map((srv) => srv.name)
          : [host];
      if (!targets.length) {
        throw new ValidationError(`Host ${host} could not be resolved`, { code: 'HOST_NOT_FOUND' });
      }
      for (const target of targets) {
        await resolvePublicHost(target, { allowPrivate: allowPrivateHosts });
      }
    }
  }

  return {
    // The databases offered, with the fields each one asks for.
    stores: () => VECTOR_STORES,

    async get(userId: string) {
      const row = await find(userId);
      if (!row) return { provider: 'ONEBOX' as const };
      return {
        provider: row.provider,
        settings: row.settings,
        keyHint: row.keyHint,
        updatedAt: row.updatedAt.toISOString(),
      };
    },

    // For search only: the store with its secrets.
    async connection(userId: string): Promise<VectorStoreConnection> {
      const row = await find(userId);
      if (!row) return { provider: 'ONEBOX' };
      return { provider: row.provider, settings: { ...row.settings, ...secretsOf(userId, row) } };
    },

    async set(userId: string, input: StoreInput) {
      const info = vectorStoreInfo(input.provider);
      const existing = await find(userId);
      const plain: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const field of info.fields) {
        // Addresses drop trailing slashes so the same address always reads the same.
        const raw = input.settings[field.key]?.trim();
        const typed = field.address ? raw?.replace(/\/+$/, '') : raw;
        const value = typed || field.default || '';
        if (value) (field.secret ? secrets : plain)[field.key] = value;
      }
      // Blank secrets carry over only to the same store at the same address.
      const sameStore =
        existing?.provider === input.provider &&
        info.fields
          .filter((field) => field.address && !field.secret)
          .every((field) => existing.settings[field.key] === plain[field.key]);
      if (sameStore) {
        const saved = secretsOf(userId, existing);
        for (const field of info.fields) {
          const kept = saved[field.key];
          if (field.secret && !secrets[field.key] && kept) secrets[field.key] = kept;
        }
      }
      for (const field of info.fields) {
        const value = plain[field.key] ?? secrets[field.key];
        if (field.required && !value) throw new ValidationError(`Enter the ${field.label}`);
        if (field.address && value) await guard(value, field.label);
      }
      await check(input.provider, { ...plain, ...secrets });
      const values = {
        provider: input.provider,
        settings: plain,
        secretsEncrypted: Object.keys(secrets).length
          ? encrypt(JSON.stringify(secrets), encryptionKey, aad(userId))
          : null,
        keyHint: hintOf(secrets),
        updatedAt: new Date(),
      };
      await db
        .insert(indexingStores)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: indexingStores.userId, set: values });
      logger.info({ userId, provider: input.provider }, 'indexing storage set');
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
