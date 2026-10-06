import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateIdentity } from './migrate';
import { refreshTokens, users } from './schema';

let pg: TestPostgres;
let client: PgClient;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 2 });
  await migrateIdentity(client, createLogger({ service: 'test', level: 'silent' }));
});

afterAll(async () => {
  await client.close();
  await pg.stop();
});

const newUser = (email: string) => ({ email, name: 'Test', passwordHash: 'hash' });

describe('identity schema', () => {
  it('enforces unique emails', async () => {
    await client.db.insert(users).values(newUser('dup@onebox.dev'));
    await expect(client.db.insert(users).values(newUser('dup@onebox.dev'))).rejects.toThrow();
  });

  it('deletes refresh tokens with their user', async () => {
    const [user] = await client.db.insert(users).values(newUser('cascade@onebox.dev')).returning();
    await client.db.insert(refreshTokens).values({
      userId: user!.id,
      familyId: crypto.randomUUID(),
      tokenHash: 'h1',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await client.db.delete(users).where(eq(users.id, user!.id));

    const remaining = await client.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, user!.id));
    expect(remaining).toHaveLength(0);
  });
});
