import { fileURLToPath } from 'node:url';
import { createLogger } from '@onebox/logger';
import { startPostgres, type TestPostgres } from '@onebox/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgClient, runMigrations, type PgClient } from './client';

const migrationsFolder = fileURLToPath(new URL('./__fixtures__/migrations', import.meta.url));
const logger = createLogger({ service: 'test', level: 'silent' });

let pg: TestPostgres;
let client: PgClient;

beforeAll(async () => {
  pg = await startPostgres();
  client = createPgClient(pg.url, { max: 2 });
});

afterAll(async () => {
  await client.close();
  await pg.stop();
});

describe('createPgClient', () => {
  it('pings the database', async () => {
    await expect(client.ping()).resolves.toBeUndefined();
  });

  it('fails ping on an unreachable database', async () => {
    const bad = createPgClient('postgres://u:p@127.0.0.1:1/none', { max: 1 });
    await expect(bad.ping()).rejects.toThrow();
    await bad.close();
  });
});

describe('runMigrations', () => {
  it('serialises concurrent runs from separate replicas', async () => {
    const replicas = [createPgClient(pg.url, { max: 2 }), createPgClient(pg.url, { max: 2 })];
    await Promise.all(
      replicas.map((replica) =>
        runMigrations(replica, { migrationsFolder, schema: 'race', logger }),
      ),
    );
    await Promise.all(replicas.map((replica) => replica.close()));

    const applied = await client.db.execute(
      sql`select count(*)::int as n from drizzle.race_migrations`,
    );
    expect(applied[0]).toEqual({ n: 1 });
  });

  it('applies migrations into the service schema and is idempotent', async () => {
    await runMigrations(client, { migrationsFolder, schema: 'fixture', logger });
    await runMigrations(client, { migrationsFolder, schema: 'fixture', logger });

    await client.db.execute(sql`insert into fixture.widgets (name) values ('a')`);
    const applied = await client.db.execute(
      sql`select count(*)::int as n from drizzle.fixture_migrations`,
    );
    expect(applied[0]).toEqual({ n: 1 });
  });
});
