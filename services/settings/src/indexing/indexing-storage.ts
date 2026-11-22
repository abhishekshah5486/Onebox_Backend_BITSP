import { resolveSrv } from 'node:dns/promises';
import {
  ONEBOX_STORE_ID,
  VECTOR_STORES,
  vectorStoreInfo,
  type VectorStoreId,
  type VectorStoreSetup,
} from '@onebox/contracts';
import { decrypt, encrypt } from '@onebox/crypto';
import { NotFoundError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { resolvePublicHost } from '@onebox/net-guard';
import { checkVectorStore, StoreCheckError } from '@onebox/vector-stores';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { indexingPreferences, indexingStores, type IndexingStoreRow } from '../db/schema';

const isUuid = (id: string) => z.uuid().safeParse(id).success;

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

// The vector stores a user keeps their mail's vectors in: OneBox's own Qdrant and any number of
// databases of theirs. Each is checked with a real connection before it's saved; each can be
// paused, so it gets no new mail; one answers searches. Search is told of every change.
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
  const rowsOf = (userId: string) =>
    db
      .select()
      .from(indexingStores)
      .where(eq(indexingStores.userId, userId))
      .orderBy(asc(indexingStores.createdAt));
  async function rowOf(userId: string, id: string) {
    if (!isUuid(id)) return undefined;
    const [row] = await db
      .select()
      .from(indexingStores)
      .where(and(eq(indexingStores.userId, userId), eq(indexingStores.id, id)));
    return row;
  }
  async function preferencesOf(userId: string) {
    const [row] = await db
      .select()
      .from(indexingPreferences)
      .where(eq(indexingPreferences.userId, userId));
    return row ?? { searchStoreId: ONEBOX_STORE_ID, oneboxPaused: false };
  }
  const setPreferences = (
    userId: string,
    values: Partial<{ searchStoreId: string; oneboxPaused: boolean }>,
  ) =>
    db
      .insert(indexingPreferences)
      .values({ userId, ...values })
      .onConflictDoUpdate({
        target: indexingPreferences.userId,
        set: { ...values, updatedAt: new Date() },
      });

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

  // The fields the user typed, split into plain settings and secrets, checked and guarded.
  // Secrets left blank are kept from `saved` when the store's address hasn't changed.
  async function prepare(userId: string, input: StoreInput, saved?: IndexingStoreRow) {
    const info = vectorStoreInfo(input.provider);
    const plain: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const field of info.fields) {
      // Addresses drop trailing slashes so the same address always reads the same.
      const raw = input.settings[field.key]?.trim();
      const typed = field.address ? raw?.replace(/\/+$/, '') : raw;
      const value = typed || field.default || '';
      if (value) (field.secret ? secrets : plain)[field.key] = value;
    }
    const sameAddress =
      saved?.provider === input.provider &&
      info.fields
        .filter((field) => field.address && !field.secret)
        .every((field) => saved.settings[field.key] === plain[field.key]);
    if (saved && sameAddress) {
      const kept = secretsOf(userId, saved);
      for (const field of info.fields) {
        const value = kept[field.key];
        if (field.secret && !secrets[field.key] && value) secrets[field.key] = value;
      }
    }
    for (const field of info.fields) {
      const value = plain[field.key] ?? secrets[field.key];
      if (field.required && !value) throw new ValidationError(`Enter the ${field.label}`);
      if (field.address && value) await guard(value, field.label);
    }
    await check(input.provider, { ...plain, ...secrets });
    return {
      provider: input.provider,
      settings: plain,
      secretsEncrypted: Object.keys(secrets).length
        ? encrypt(JSON.stringify(secrets), encryptionKey, aad(userId))
        : null,
      keyHint: hintOf(secrets),
    };
  }

  const view = (row: IndexingStoreRow, searchStoreId: string) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    settings: row.settings,
    keyHint: row.keyHint,
    paused: row.paused,
    search: row.id === searchStoreId,
    updatedAt: row.updatedAt.toISOString(),
  });

  async function list(userId: string) {
    const [rows, preferences] = await Promise.all([rowsOf(userId), preferencesOf(userId)]);
    return {
      searchStoreId: preferences.searchStoreId,
      stores: [
        {
          id: ONEBOX_STORE_ID,
          name: 'OneBox hosted',
          provider: 'ONEBOX' as const,
          paused: preferences.oneboxPaused,
          search: preferences.searchStoreId === ONEBOX_STORE_ID,
        },
        ...rows.map((row) => view(row, preferences.searchStoreId)),
      ],
    };
  }

  async function mustFind(userId: string, id: string) {
    const row = await rowOf(userId, id);
    if (!row) throw new NotFoundError('No such vector store');
    return row;
  }

  return {
    // The databases offered, with the fields each one asks for.
    catalogue: () => VECTOR_STORES,

    list,

    // For search only: every store with its secrets, and the one searches use.
    async setup(userId: string): Promise<VectorStoreSetup> {
      const [rows, preferences] = await Promise.all([rowsOf(userId), preferencesOf(userId)]);
      return {
        searchStoreId: preferences.searchStoreId,
        stores: [
          { id: ONEBOX_STORE_ID, provider: 'ONEBOX', paused: preferences.oneboxPaused },
          ...rows.map((row) => ({
            id: row.id,
            provider: row.provider,
            paused: row.paused,
            settings: { ...row.settings, ...secretsOf(userId, row) },
          })),
        ],
      };
    },

    // Another store, any kind, as many as the user likes. It starts filling straight away.
    async add(userId: string, input: StoreInput & { name?: string | undefined }) {
      const values = await prepare(userId, input);
      const existing = await rowsOf(userId);
      const kind = vectorStoreInfo(input.provider).name;
      const sameKind = existing.filter((row) => row.provider === input.provider).length;
      const name = input.name?.trim() || (sameKind ? `${kind} ${sameKind + 1}` : kind);
      const [row] = await db
        .insert(indexingStores)
        .values({ userId, name, ...values })
        .returning();
      logger.info({ userId, storeId: row!.id, provider: input.provider }, 'vector store added');
      await tellSearch(userId);
      return view(row!, (await preferencesOf(userId)).searchStoreId);
    },

    // A new name, new settings (checked again) or a pause; OneBox's own can only be paused.
    async update(
      userId: string,
      id: string,
      input: { name?: string | undefined; settings?: StoreInput['settings']; paused?: boolean },
    ) {
      const preferences = await preferencesOf(userId);
      if (input.paused && preferences.searchStoreId === id) {
        throw new ValidationError('Searches use this store; pick another for search first', {
          code: 'SEARCH_STORE_PAUSED',
        });
      }
      if (id === ONEBOX_STORE_ID) {
        if (input.paused !== undefined)
          await setPreferences(userId, { oneboxPaused: input.paused });
      } else {
        const row = await mustFind(userId, id);
        const values = input.settings
          ? await prepare(userId, { provider: row.provider, settings: input.settings }, row)
          : {};
        await db
          .update(indexingStores)
          .set({
            ...values,
            ...(input.name?.trim() && { name: input.name.trim() }),
            ...(input.paused !== undefined && { paused: input.paused }),
            updatedAt: new Date(),
          })
          .where(eq(indexingStores.id, id));
      }
      logger.info({ userId, storeId: id, paused: input.paused }, 'vector store updated');
      await tellSearch(userId);
      return list(userId);
    },

    // Searches go to this store from now on; it's resumed if it was paused.
    async useForSearch(userId: string, id: string) {
      if (id === ONEBOX_STORE_ID) {
        await setPreferences(userId, { searchStoreId: id, oneboxPaused: false });
      } else {
        await mustFind(userId, id);
        await db
          .update(indexingStores)
          .set({ paused: false, updatedAt: new Date() })
          .where(eq(indexingStores.id, id));
        await setPreferences(userId, { searchStoreId: id });
      }
      logger.info({ userId, storeId: id }, 'search store chosen');
      await tellSearch(userId);
      return list(userId);
    },

    // OneBox forgets the store; its vectors stay there. Searches fall back to OneBox's own.
    async remove(userId: string, id: string) {
      if (id === ONEBOX_STORE_ID) {
        throw new ValidationError('OneBox’s own store can be paused but not removed');
      }
      await mustFind(userId, id);
      await db.delete(indexingStores).where(eq(indexingStores.id, id));
      if ((await preferencesOf(userId)).searchStoreId === id) {
        await setPreferences(userId, { searchStoreId: ONEBOX_STORE_ID, oneboxPaused: false });
      }
      logger.info({ userId, storeId: id }, 'vector store removed');
      await tellSearch(userId);
    },
  };
}

export type IndexingStorage = ReturnType<typeof createIndexingStorage>;
