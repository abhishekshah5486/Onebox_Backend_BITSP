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

  const lockFamily = (tx: Pick<PostgresJsDatabase, 'execute'>, familyId: string) =>
    tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`refresh-family:${familyId}`}))`);

  // Taken after the lock, the update sees any successor a concurrent rotation just committed.
  const revokeFamily = (familyId: string, now: Date) =>
    db.transaction(async (tx) => {
      await lockFamily(tx, familyId);
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    });

  return {
    issue(userId: string, meta: ClientMeta = {}, now = new Date()) {
      return insert(db, userId, randomUUID(), meta, now);
    },

    // Rotation and family revocation run under the same per-family lock, so a logout or a
    // detected reuse can never miss a successor issued at the same moment.
    async rotate(presented: string, meta: ClientMeta = {}, now = new Date()) {
      const [found] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(presented)));
      if (!found) throw invalid();

      const token = randomBytes(32).toString('base64url');
      const at = now.toISOString();
      const expires = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
      const rotated = await db.transaction(async (tx) => {
        await lockFamily(tx, found.familyId);
        const rows = await tx.execute<{ user_id: string }>(sql`
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
        return rows[0];
      });
      if (rotated) return { userId: rotated.user_id, refreshToken: token };

      // Expired and never used: just invalid. Already rotated or revoked: someone replayed it.
      if (!found.rotatedAt && !found.revokedAt) throw invalid();
      await revokeFamily(found.familyId, now);
      logger.warn(
        { userId: found.userId, familyId: found.familyId },
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
      await revokeFamily(row.familyId, now);
      logger.info({ userId: row.userId }, 'session revoked');
    },
  };
}

export type RefreshTokens = ReturnType<typeof createRefreshTokens>;
