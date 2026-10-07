import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { UnauthorizedError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { refreshTokens } from '../db/schema';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ClientMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

// Only the hash is stored, so a database leak does not expose usable tokens.
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const invalid = () =>
  new UnauthorizedError('Invalid refresh token', { code: 'INVALID_REFRESH_TOKEN' });

export function createRefreshTokens(db: PostgresJsDatabase, logger: Logger) {
  async function insert(
    executor: Pick<PostgresJsDatabase, 'insert'>,
    userId: string,
    familyId: string,
    meta: ClientMeta,
    now: Date,
  ) {
    const token = randomBytes(32).toString('base64url');
    await executor.insert(refreshTokens).values({
      userId,
      familyId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return token;
  }

  return {
    issue(userId: string, meta: ClientMeta = {}, now = new Date()) {
      return insert(db, userId, randomUUID(), meta, now);
    },

    // One atomic statement in the common case: the database is a long round trip away, and a
    // concurrent rotation of the same token simply finds it already rotated.
    async rotate(presented: string, meta: ClientMeta = {}, now = new Date()) {
      const token = randomBytes(32).toString('base64url');
      const at = now.toISOString();
      const expires = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
      const rows = await db.execute<{ user_id: string }>(sql`
        with rotated as (
          update ${refreshTokens} set rotated_at = ${at}::timestamptz
          where token_hash = ${hashToken(presented)}
            and rotated_at is null and revoked_at is null and expires_at > ${at}::timestamptz
          returning user_id, family_id
        )
        insert into ${refreshTokens} (user_id, family_id, token_hash, expires_at, user_agent, ip)
        select user_id, family_id, ${hashToken(token)},
          ${expires}::timestamptz, ${meta.userAgent ?? null}, ${meta.ip ?? null}
        from rotated
        returning user_id`);
      const [rotated] = rows;
      if (rotated) return { userId: rotated.user_id, refreshToken: token };

      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(presented)));
      if (!row || (!row.rotatedAt && !row.revokedAt)) throw invalid();

      await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
      logger.warn(
        { userId: row.userId, familyId: row.familyId },
        'refresh token reuse detected, session revoked',
      );
      throw new UnauthorizedError('Refresh token already used', { code: 'REFRESH_TOKEN_REUSED' });
    },

    async revoke(presented: string, now = new Date()) {
      const [row] = await db
        .select({ familyId: refreshTokens.familyId, userId: refreshTokens.userId })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(presented)));
      if (!row) return;
      await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
      logger.info({ userId: row.userId }, 'session revoked');
    },
  };
}

export type RefreshTokens = ReturnType<typeof createRefreshTokens>;
