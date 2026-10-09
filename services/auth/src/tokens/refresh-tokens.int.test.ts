import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateIdentity } from '../db/migrate';
import { refreshTokens, users } from '../db/schema';
import { createRefreshTokens, REFRESH_TOKEN_TTL_MS, type RefreshTokens } from './refresh-tokens';

const logger = createLogger({ service: 'test', level: 'silent' });

let pg: TestPostgres;
let client: PgClient;
let tokens: RefreshTokens;
let userId: string;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 4 });
  await migrateIdentity(client, logger);
  tokens = createRefreshTokens(client.db, logger);
  const [user] = await client.db
    .insert(users)
    .values({ email: 'r@onebox.dev', name: 'R', passwordHash: 'x' })
    .returning();
  userId = user!.id;
});

afterAll(async () => {
  await client.close();
  await pg.stop();
});

describe('refresh tokens', () => {
  it('stores only a hash of the token', async () => {
    const token = await tokens.issue(userId, { userAgent: 'vitest', ip: '127.0.0.1' });
    const rows = await client.db.select().from(refreshTokens);
    expect(rows.some((row) => row.tokenHash === token)).toBe(false);
    expect(rows.at(-1)).toMatchObject({ userAgent: 'vitest', ip: '127.0.0.1' });
  });

  it('rotates into a new token for the same user', async () => {
    const first = await tokens.issue(userId);
    const rotated = await tokens.rotate(first);

    expect(rotated.userId).toBe(userId);
    expect(rotated.refreshToken).not.toBe(first);
    await expect(tokens.rotate(rotated.refreshToken)).resolves.toMatchObject({ userId });
  });

  it('revokes the whole family when a rotated token is reused', async () => {
    const first = await tokens.issue(userId);
    const { refreshToken: second } = await tokens.rotate(first);

    await expect(tokens.rotate(first)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
    await expect(tokens.rotate(second)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
  });

  it('rejects unknown and expired tokens', async () => {
    await expect(tokens.rotate('unknown')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    const issuedLongAgo = new Date(Date.now() - REFRESH_TOKEN_TTL_MS - 1000);
    const stale = await tokens.issue(userId, {}, issuedLongAgo);
    await expect(tokens.rotate(stale)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
  });

  it('logout revokes the session', async () => {
    const token = await tokens.issue(userId);
    await tokens.revoke(token);
    await expect(tokens.rotate(token)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
  });

  it('lets only one of two concurrent rotations succeed', async () => {
    const token = await tokens.issue(userId);
    const results = await Promise.allSettled([tokens.rotate(token), tokens.rotate(token)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('never leaves a usable successor when logout races a rotation', async () => {
    for (let i = 0; i < 10; i++) {
      const token = await tokens.issue(userId);
      const [rotated] = await Promise.allSettled([tokens.rotate(token), tokens.revoke(token)]);
      if (rotated.status === 'fulfilled') {
        await expect(tokens.rotate(rotated.value.refreshToken)).rejects.toBeDefined();
      }
    }
  });
});
