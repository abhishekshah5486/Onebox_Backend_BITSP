import { ConflictError, NotFoundError, UnauthorizedError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { users } from '../db/schema';
import type { KeyStore } from '../keys/key-store';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../passwords';
import { ACCESS_TOKEN_TTL_SECONDS, issueAccessToken } from '../tokens/access-token';
import type { ClientMeta, RefreshTokens } from '../tokens/refresh-tokens';

export interface UserServiceDeps {
  db: PostgresJsDatabase;
  keyStore: KeyStore;
  refreshTokens: RefreshTokens;
  logger: Logger;
}

type UserRow = typeof users.$inferSelect;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const toProfile = (user: UserRow) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.createdAt.toISOString(),
});

const isUniqueViolation = (err: unknown) =>
  [err, (err as { cause?: unknown })?.cause].some(
    (e) => (e as { code?: string } | undefined)?.code === '23505',
  );

const invalidCredentials = () =>
  new UnauthorizedError('Invalid email or password', { code: 'INVALID_CREDENTIALS' });

export function createUserService({ db, keyStore, refreshTokens, logger }: UserServiceDeps) {
  async function issueSession(user: UserRow, meta: ClientMeta, refreshToken?: string) {
    const key = await keyStore.getActiveKey();
    return {
      user: toProfile(user),
      tokens: {
        tokenType: 'Bearer' as const,
        accessToken: await issueAccessToken(key, user),
        refreshToken: refreshToken ?? (await refreshTokens.issue(user.id, meta)),
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
    };
  }

  async function findById(id: string) {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  return {
    async register(input: { email: string; name: string; password: string }, meta: ClientMeta) {
      const passwordHash = await hashPassword(input.password);
      try {
        const [user] = await db
          .insert(users)
          .values({ email: normalizeEmail(input.email), name: input.name, passwordHash })
          .returning();
        logger.info({ userId: user!.id }, 'user registered');
        return issueSession(user!, meta);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError('An account with this email already exists', {
            code: 'EMAIL_TAKEN',
          });
        }
        throw err;
      }
    },

    async login(input: { email: string; password: string }, meta: ClientMeta) {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, normalizeEmail(input.email)));
      const valid = user
        ? await verifyPassword(user.passwordHash, input.password)
        : await verifyAgainstDummy(input.password);
      if (!user || !valid) {
        logger.warn({ userId: user?.id ?? null }, 'login failed');
        throw invalidCredentials();
      }

      const [updated] = await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id))
        .returning();
      logger.info({ userId: user.id }, 'user logged in');
      return issueSession(updated!, meta);
    },

    async refresh(refreshToken: string, meta: ClientMeta) {
      const rotated = await refreshTokens.rotate(refreshToken, meta);
      const user = await findById(rotated.userId);
      if (!user) throw invalidCredentials();
      return issueSession(user, meta, rotated.refreshToken);
    },

    logout: (refreshToken: string) => refreshTokens.revoke(refreshToken),

    async getProfile(userId: string) {
      const user = await findById(userId);
      if (!user) throw new NotFoundError('User not found');
      return toProfile(user);
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
