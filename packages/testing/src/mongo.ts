import { MongoDBContainer } from '@testcontainers/mongodb';

export interface TestMongo {
  uri: string;
  stop: () => Promise<void>;
}

export async function startMongo(): Promise<TestMongo> {
  const container = await new MongoDBContainer('mongo:8.0').start();
  return {
    uri: `${container.getConnectionString()}?directConnection=true`,
    stop: async () => {
      await container.stop();
    },
  };
}
