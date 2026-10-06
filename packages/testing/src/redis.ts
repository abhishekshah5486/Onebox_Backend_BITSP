import { GenericContainer, Wait } from 'testcontainers';

export interface TestRedis {
  url: string;
  stop: () => Promise<void>;
}

export async function startRedis(): Promise<TestRedis> {
  const container = await new GenericContainer('redis:8.10.2-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
