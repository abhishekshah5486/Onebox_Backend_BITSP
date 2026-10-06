import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { UnauthorizedError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { and, eq, isNull } from 'drizzle-orm';
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

    async rotate(presented: string, meta: ClientMeta = {}, now = new Date()) {
      const outcome = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, hashToken(presented)))
          .for('update');
        if (!row) return { kind: 'invalid' as const };

        if (row.rotatedAt || row.revokedAt) {
          await tx
            .update(refreshTokens)
            .set({ revokedAt: now })
            .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
          return { kind: 'reused' as const, userId: row.userId, familyId: row.familyId };
        }
        if (row.expiresAt <= now) return { kind: 'invalid' as const };

        await tx.update(refreshTokens).set({ rotatedAt: now }).where(eq(refreshTokens.id, row.id));
        const token = await insert(tx, row.userId, row.familyId, meta, now);
        return { kind: 'rotated' as const, userId: row.userId, token };
      });

      if (outcome.kind === 'reused') {
        logger.warn(
          { userId: outcome.userId, familyId: outcome.familyId },
          'refresh token reuse detected, session revoked',
        );
        throw new UnauthorizedError('Refresh token already used', { code: 'REFRESH_TOKEN_REUSED' });
      }
      if (outcome.kind === 'invalid') throw invalid();
      return { userId: outcome.userId, refreshToken: outcome.token };
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
