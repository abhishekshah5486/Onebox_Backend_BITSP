import { MongoClient, type Db } from 'mongodb';

export interface MongoHandle {
  db: Db;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

// Each service gets its own database on the shared cluster, mirroring Postgres schemas.
export async function connectMongo(uri: string, dbName: string): Promise<MongoHandle> {
  const client = new MongoClient(uri, {
    appName: `onebox-${dbName}`,
    serverSelectionTimeoutMS: 10_000,
    retryWrites: true,
  });
  await client.connect();
  const db = client.db(dbName);
  return {
    db,
    ping: async () => {
      await db.command({ ping: 1 });
    },
    close: () => client.close(),
  };
}

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number } | undefined)?.code === 11000;
}
