import { randomUUID } from 'node:crypto';
import { createPgClient, type PgClient } from '@onebox/db-pg';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAccounts } from './migrate';
import { emailAccounts } from './schema';

let pg: TestPostgres;
let client: PgClient;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 2 });
  await migrateAccounts(client, createLogger({ service: 'test', level: 'silent' }));
});

afterAll(async () => {
  await client.close();
  await pg.stop();
});

const account = (userId: string, emailAddress: string) => ({
  userId,
  provider: 'IMAP' as const,
  emailAddress,
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapTls: true,
  username: emailAddress,
  credentialsEncrypted: 'v1.x.y.z',
});

describe('accounts schema', () => {
  it('lets two users add the same mailbox but not one user twice', async () => {
    const [alice, bob] = [randomUUID(), randomUUID()];
    await client.db.insert(emailAccounts).values(account(alice, 'shared@example.com'));
    await client.db.insert(emailAccounts).values(account(bob, 'shared@example.com'));

    await expect(
      client.db.insert(emailAccounts).values(account(alice, 'shared@example.com')),
    ).rejects.toThrow();
  });

  it('defaults status to CONNECTED and sync state to empty', async () => {
    const [row] = await client.db
      .insert(emailAccounts)
      .values(account(randomUUID(), 'new@example.com'))
      .returning();
    expect(row).toMatchObject({ status: 'CONNECTED', syncState: {} });
  });
});
