import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlobStore } from './index';

const config = (port: number) => ({
  BLOB_ENDPOINT: `http://127.0.0.1:${port}`,
  BLOB_REGION: 'us-east-1',
  BLOB_BUCKET: 'late-bucket',
  BLOB_ACCESS_KEY: 'key',
  BLOB_SECRET_KEY: 'secret',
});

let server: Server | undefined;
afterEach(() => server?.close());

describe('ensureBucket', () => {
  it('waits for a store that is still starting', async () => {
    const free = createServer().listen(0);
    await new Promise((resolve) => free.once('listening', resolve));
    const { port } = free.address() as AddressInfo;
    await new Promise((resolve) => free.close(resolve));

    const retries: number[] = [];
    const ready = createBlobStore(config(port)).ensureBucket({
      onRetry: (_, attempt) => retries.push(attempt),
    });
    setTimeout(() => {
      // The bucket already exists: HeadBucket answers 200.
      server = createServer((_, res) => res.writeHead(200).end()).listen(port, '127.0.0.1');
    }, 1_000);

    await expect(ready).resolves.toBeUndefined();
    expect(retries.length).toBeGreaterThan(0);
  });
});
