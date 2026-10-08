import { MongoClient, type Db } from 'mongodb';

export interface MongoHandle {
  db: Db;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Each service gets its own database on the shared cluster, mirroring Postgres schemas.
// A brief DNS or network blip at startup is retried with backoff rather than ending the process.
export async function connectMongo(
  uri: string,
  dbName: string,
  {
    attempts = 6,
    onRetry,
  }: { attempts?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<MongoHandle> {
  let client: MongoClient;
  for (let attempt = 1; ; attempt++) {
    client = new MongoClient(uri, {
      appName: `onebox-${dbName}`,
      serverSelectionTimeoutMS: 10_000,
      retryWrites: true,
    });
    try {
      await client.connect();
      break;
    } catch (err) {
      await client.close().catch(() => {});
      if (attempt >= attempts) throw err;
      onRetry?.(err, attempt);
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));
    }
  }
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
