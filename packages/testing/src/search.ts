import { GenericContainer, Wait } from 'testcontainers';

export interface TestService {
  url: string;
  stop: () => Promise<void>;
}

export async function startElasticsearch(): Promise<TestService> {
  const container = await new GenericContainer(
    'docker.elastic.co/elasticsearch/elasticsearch:9.5.3',
  )
    .withEnvironment({
      'discovery.type': 'single-node',
      'xpack.security.enabled': 'false',
      ES_JAVA_OPTS: '-Xms256m -Xmx256m',
    })
    .withExposedPorts(9200)
    .withWaitStrategy(Wait.forHttp('/_cluster/health?wait_for_status=yellow', 9200))
    .withStartupTimeout(180_000)
    .start();
  return {
    url: `http://${container.getHost()}:${container.getMappedPort(9200)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startQdrant(): Promise<TestService> {
  const container = await new GenericContainer('qdrant/qdrant:v1.19.2')
    .withExposedPorts(6333)
    .withWaitStrategy(Wait.forHttp('/readyz', 6333))
    .start();
  return {
    url: `http://${container.getHost()}:${container.getMappedPort(6333)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
