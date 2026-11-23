import { GenericContainer, Wait } from 'testcontainers';

export interface TestObjectStore {
  url: string;
  accessKeyId: string;
  secretAccessKey: string;
  stop: () => Promise<void>;
}

// An S3-compatible store (the same SeaweedFS the dev stack runs).
export async function startS3(): Promise<TestObjectStore> {
  const accessKeyId = 'testaccesskey';
  const secretAccessKey = 'testsecretkey';
  const container = await new GenericContainer('chrislusf/seaweedfs:4.48')
    .withEnvironment({ AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey })
    .withCommand(['server', '-dir=/data', '-s3', '-s3.port=8333', '-ip.bind=0.0.0.0'])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  return {
    url: `http://${container.getHost()}:${container.getMappedPort(8333)}`,
    accessKeyId,
    secretAccessKey,
    stop: async () => {
      await container.stop();
    },
  };
}

export interface TestAzurite {
  // Blob endpoint for an account: http://host:port/<account>.
  endpoint: (accountName: string) => string;
  accountName: string;
  accountKey: string;
  stop: () => Promise<void>;
}

// Microsoft's Azure Storage emulator, with its well-known development account.
export async function startAzurite(): Promise<TestAzurite> {
  const container = await new GenericContainer('mcr.microsoft.com/azure-storage/azurite:3.35.0')
    .withCommand(['azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck'])
    .withExposedPorts(10000)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const base = `http://${container.getHost()}:${container.getMappedPort(10000)}`;
  return {
    endpoint: (accountName) => `${base}/${accountName}`,
    accountName: 'devstoreaccount1',
    // Azurite's published development key, not a secret.
    accountKey:
      'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
    stop: async () => {
      await container.stop();
    },
  };
}
