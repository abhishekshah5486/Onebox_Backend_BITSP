import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

// A vector database in a container, with the settings a user would type to reach it.
export interface TestVectorStore {
  settings: Record<string, string>;
  stop: () => Promise<void>;
}

const at = (container: StartedTestContainer, port: number, scheme = 'http') =>
  `${scheme}://${container.getHost()}:${container.getMappedPort(port)}`;
const stopper = (container: StartedTestContainer) => async () => {
  await container.stop();
};

// Pinecone's local emulator. Index ports are handed out from 5081, and the SDK is told the
// host it reports, so those ports are mapped to themselves.
export async function startPinecone(): Promise<TestVectorStore> {
  const container = await new GenericContainer('ghcr.io/pinecone-io/pinecone-local:v1.0.0.rc0')
    .withEnvironment({ PORT: '5080', PINECONE_HOST: 'localhost' })
    .withExposedPorts(
      { container: 5080, host: 5080 },
      { container: 5081, host: 5081 },
      { container: 5082, host: 5082 },
    )
    // Only published for Intel, so on Apple silicon it runs emulated and starts slowly.
    .withPlatform('linux/amd64')
    .withWaitStrategy(Wait.forHttp('/indexes', 5080).withHeaders({ 'Api-Key': 'pclocal' }))
    .withStartupTimeout(180_000)
    .start();
  return {
    settings: {
      apiKey: 'pclocal',
      controllerHost: 'http://localhost:5080',
      cloud: 'aws',
      region: 'us-east-1',
    },
    stop: stopper(container),
  };
}

export async function startWeaviate(): Promise<TestVectorStore> {
  const container = await new GenericContainer('cr.weaviate.io/semitechnologies/weaviate:1.33.2')
    .withEnvironment({
      AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED: 'true',
      PERSISTENCE_DATA_PATH: '/var/lib/weaviate',
      DEFAULT_VECTORIZER_MODULE: 'none',
      CLUSTER_HOSTNAME: 'node1',
    })
    .withExposedPorts(8080, 50051)
    .withWaitStrategy(Wait.forHttp('/v1/.well-known/ready', 8080))
    .start();
  return {
    settings: { url: at(container, 8080), grpcUrl: at(container, 50051) },
    stop: stopper(container),
  };
}

// Milvus standalone with its etcd built in, as Milvus's own quick start runs it.
export async function startMilvus(): Promise<TestVectorStore> {
  const container = await new GenericContainer('milvusdb/milvus:v2.6.4')
    .withCommand(['milvus', 'run', 'standalone'])
    .withEnvironment({
      ETCD_USE_EMBED: 'true',
      ETCD_DATA_DIR: '/var/lib/milvus/etcd',
      ETCD_CONFIG_PATH: '/milvus/configs/embedEtcd.yaml',
      COMMON_STORAGETYPE: 'local',
      DEPLOY_MODE: 'STANDALONE',
    })
    .withCopyContentToContainer([
      {
        content: [
          'listen-client-urls: http://0.0.0.0:2379',
          'advertise-client-urls: http://0.0.0.0:2379',
          'quota-backend-bytes: 4294967296',
          'auto-compaction-mode: revision',
          "auto-compaction-retention: '1000'",
        ].join('\n'),
        target: '/milvus/configs/embedEtcd.yaml',
      },
      {
        content: '# Extra config to override default milvus.yaml\n',
        target: '/milvus/configs/user.yaml',
      },
    ])
    .withExposedPorts(19530, 9091)
    .withWaitStrategy(Wait.forHttp('/healthz', 9091))
    .withStartupTimeout(240_000)
    .start();
  return {
    // gRPC would try IPv6 first for "localhost", where Docker doesn't listen.
    settings: {
      address: `${container.getHost().replace(/^localhost$/, '127.0.0.1')}:${container.getMappedPort(19530)}`,
    },
    stop: stopper(container),
  };
}

export async function startChroma(): Promise<TestVectorStore> {
  const container = await new GenericContainer('chromadb/chroma:1.3.0')
    .withExposedPorts(8000)
    .withWaitStrategy(Wait.forHttp('/api/v2/heartbeat', 8000))
    .start();
  return { settings: { url: at(container, 8000) }, stop: stopper(container) };
}

export async function startPgvector(): Promise<TestVectorStore> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:0.8.1-pg17').start();
  return { settings: { connectionString: container.getConnectionUri() }, stop: stopper(container) };
}

export async function startOpenSearch(): Promise<TestVectorStore> {
  const container = await new GenericContainer('opensearchproject/opensearch:3.3.0')
    .withEnvironment({
      'discovery.type': 'single-node',
      DISABLE_SECURITY_PLUGIN: 'true',
      DISABLE_INSTALL_DEMO_CONFIG: 'true',
      OPENSEARCH_JAVA_OPTS: '-Xms512m -Xmx512m',
    })
    .withExposedPorts(9200)
    .withWaitStrategy(Wait.forHttp('/', 9200))
    .withStartupTimeout(180_000)
    .start();
  return { settings: { url: at(container, 9200) }, stop: stopper(container) };
}

// MongoDB's local build of Atlas, with Atlas Vector Search.
export async function startAtlas(): Promise<TestVectorStore> {
  const container = await new GenericContainer('mongodb/mongodb-atlas-local:8.0.15')
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(240_000)
    .start();
  return {
    settings: {
      connectionString: `${at(container, 27017, 'mongodb')}/?directConnection=true`,
      database: 'onebox',
    },
    stop: stopper(container),
  };
}

export async function startNeo4j(): Promise<TestVectorStore> {
  const password = 'onebox-test-password';
  const container = await new GenericContainer('neo4j:5.26.15')
    .withEnvironment({
      NEO4J_AUTH: `neo4j/${password}`,
      NEO4J_server_memory_heap_max__size: '512m',
    })
    .withExposedPorts(7687, 7474)
    .withWaitStrategy(Wait.forLogMessage(/Started\./))
    .withStartupTimeout(180_000)
    .start();
  return {
    settings: { url: at(container, 7687, 'bolt'), username: 'neo4j', password },
    stop: stopper(container),
  };
}
