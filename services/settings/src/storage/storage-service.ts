import { decrypt, encrypt } from '@onebox/crypto';
import { AppError, NotFoundError, ServiceUnavailableError, ValidationError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { and, asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { storageAccounts, type StorageAccountRow } from '../db/schema';
import {
  ACCESS_DENIED,
  ExpiredGrantError,
  PROVIDER_NAMES,
  type StorageProvider,
  type StorageProviderId,
} from './provider';
import { createStateSigner, STATE_TTL_MS } from './state';

const MAX_ACCOUNTS = 10;
// How long a failed sign-in is remembered, so the page that started it can say why.
const FAILURE_TTL_MS = 15 * 60_000;

export interface SignInFailure {
  provider: StorageProviderId;
  reason: 'ACCESS_DENIED' | 'FAILED';
  message: string;
  at: string;
}

export interface StorageServiceDeps {
  db: PostgresJsDatabase;
  encryptionKey: Buffer;
  logger: Logger;
  // Only providers with credentials on this server.
  providers: Partial<Record<StorageProviderId, StorageProvider>>;
}

// Google tokens were encrypted under "google:<userId>" before other providers existed.
const AAD_PREFIX: Record<StorageProviderId, string> = {
  GOOGLE_DRIVE: 'google',
  ONEDRIVE: 'onedrive',
  DROPBOX: 'dropbox',
};
const aadFor = (row: { provider: StorageProviderId; userId: string }) =>
  `${AAD_PREFIX[row.provider]}:${row.userId}`;

export function createStorageService({ db, encryptionKey, logger, providers }: StorageServiceDeps) {
  const state = createStateSigner(encryptionKey);
  const accessTokens = new Map<string, { token: string; expiresAt: number }>();
  // Recent failed sign-ins per user, kept in memory: they only matter for a few minutes.
  const failures = new Map<string, SignInFailure[]>();

  const recentFailures = (userId: string) => {
    const since = Date.now() - FAILURE_TTL_MS;
    const recent = (failures.get(userId) ?? []).filter((f) => Date.parse(f.at) > since);
    if (recent.length) failures.set(userId, recent);
    else failures.delete(userId);
    return recent;
  };

  const recordFailure = (userId: string, failure: Omit<SignInFailure, 'at'>) =>
    failures.set(userId, [
      ...recentFailures(userId).slice(-9),
      { ...failure, at: new Date().toISOString() },
    ]);

  const userOf = (provider: StorageProviderId, signedState: string) => {
    const [signedFor, userId] = state.verify(signedState)?.split(':') ?? [];
    return signedFor === provider && userId ? userId : null;
  };

  const providerFor = (id: StorageProviderId) => {
    const provider = providers[id];
    if (!provider) throw new ServiceUnavailableError(`${PROVIDER_NAMES[id]} is not set up`);
    return provider;
  };

  const ownAccount = (userId: string, id: string) =>
    db
      .select()
      .from(storageAccounts)
      .where(and(eq(storageAccounts.id, id), eq(storageAccounts.userId, userId)))
      .then((rows) => {
        if (!rows[0]) throw new NotFoundError('That storage account is not connected');
        return rows[0];
      });

  const view = (row: StorageAccountRow) => ({
    id: row.id,
    provider: row.provider,
    email: row.email,
    defaultPath: row.defaultPath,
    connectedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  const remember = (id: string, access: { token: string; expiresIn: number }) =>
    accessTokens.set(id, { token: access.token, expiresAt: Date.now() + access.expiresIn * 1000 });

  return {
    authUrl(userId: string, provider: StorageProviderId) {
      return {
        url: providerFor(provider).authUrl(state.sign(`${provider}:${userId}`)),
        expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
      };
    },

    // Finishes a sign-in started by authUrl and returns the connected address. Connecting the
    // same account again refreshes its token and keeps its folder.
    async complete(provider: StorageProviderId, code: string, signedState: string) {
      const userId = userOf(provider, signedState);
      if (!userId) throw new ValidationError('This sign-in link has expired. Please try again.');
      let exchanged;
      try {
        exchanged = await providerFor(provider).exchange(code);
      } catch (err) {
        recordFailure(userId, {
          provider,
          reason:
            err instanceof AppError && err.code === ACCESS_DENIED ? 'ACCESS_DENIED' : 'FAILED',
          message: err instanceof AppError ? err.message : 'Something went wrong.',
        });
        throw err;
      }
      const { email, refreshToken, scopes, access } = exchanged;
      const mine = and(eq(storageAccounts.userId, userId), eq(storageAccounts.provider, provider));
      const existing = await db
        .select({ id: storageAccounts.id })
        .from(storageAccounts)
        .where(and(mine, eq(storageAccounts.email, email)));
      const count = await db.$count(storageAccounts, eq(storageAccounts.userId, userId));
      if (!existing[0] && count >= MAX_ACCOUNTS) {
        throw new ValidationError(`You can connect up to ${MAX_ACCOUNTS} storage accounts.`);
      }
      const values = {
        refreshTokenEncrypted: encrypt(refreshToken, encryptionKey, aadFor({ provider, userId })),
        scopes,
      };
      const [row] = await db
        .insert(storageAccounts)
        .values({ userId, provider, email, ...values })
        .onConflictDoUpdate({
          target: [storageAccounts.userId, storageAccounts.provider, storageAccounts.email],
          set: values,
        })
        .returning({ id: storageAccounts.id });
      if (row && access) remember(row.id, access);
      logger.info({ userId, provider }, 'storage account connected');
      return email;
    },

    // The provider sent the person back without a sign-in, e.g. they declined access.
    refuse(provider: StorageProviderId, signedState: string, error: string) {
      const userId = userOf(provider, signedState);
      if (!userId) return;
      recordFailure(userId, {
        provider,
        reason: error === 'access_denied' ? 'ACCESS_DENIED' : 'FAILED',
        message:
          error === 'access_denied'
            ? `OneBox was not given access to ${PROVIDER_NAMES[provider]}.`
            : `${PROVIDER_NAMES[provider]} could not finish the sign-in.`,
      });
    },

    async list(userId: string) {
      const rows = await db
        .select()
        .from(storageAccounts)
        .where(eq(storageAccounts.userId, userId))
        .orderBy(asc(storageAccounts.createdAt));
      return {
        providers: (Object.keys(providers) as StorageProviderId[]).filter((id) => providers[id]),
        accounts: rows.map(view),
        failures: recentFailures(userId),
      };
    },

    async setDefaultPath(userId: string, id: string, defaultPath: string) {
      await ownAccount(userId, id);
      const [row] = await db
        .update(storageAccounts)
        .set({ defaultPath })
        .where(eq(storageAccounts.id, id))
        .returning();
      return view(row!);
    },

    async disconnect(userId: string, id: string) {
      const row = await ownAccount(userId, id);
      await db.delete(storageAccounts).where(eq(storageAccounts.id, id));
      accessTokens.delete(id);
      const token = decrypt(row.refreshTokenEncrypted, encryptionKey, aadFor(row));
      await providers[row.provider]
        ?.revoke(token)
        .catch((err: unknown) => logger.warn({ err }, 'storage token revoke failed'));
      logger.info({ userId, provider: row.provider }, 'storage account disconnected');
    },

    // A short-lived access token for calls other services make to the provider.
    async accessToken(userId: string, id: string) {
      const row = await ownAccount(userId, id);
      const cached = accessTokens.get(id);
      if (cached && cached.expiresAt - 60_000 > Date.now()) {
        return { provider: row.provider, accessToken: cached.token };
      }
      try {
        const access = await providerFor(row.provider).refresh(
          decrypt(row.refreshTokenEncrypted, encryptionKey, aadFor(row)),
        );
        remember(id, access);
        if (access.refreshToken) {
          await db
            .update(storageAccounts)
            .set({
              refreshTokenEncrypted: encrypt(access.refreshToken, encryptionKey, aadFor(row)),
            })
            .where(eq(storageAccounts.id, id));
        }
        return { provider: row.provider, accessToken: access.token };
      } catch (err) {
        if (!(err instanceof ExpiredGrantError)) throw err;
        await db.delete(storageAccounts).where(eq(storageAccounts.id, id));
        throw new NotFoundError(
          `${PROVIDER_NAMES[row.provider]} access for ${row.email} has expired. Please connect it again.`,
        );
      }
    },
  };
}

export type StorageService = ReturnType<typeof createStorageService>;
