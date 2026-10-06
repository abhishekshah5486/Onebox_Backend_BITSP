import { PostgreSqlContainer } from '@testcontainers/postgresql';

export interface TestPostgres {
  url: string;
  stop: () => Promise<void>;
}

// Matches the Supabase major version so migrations behave the same in tests.
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
