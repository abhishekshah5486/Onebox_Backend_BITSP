import { startRedis, type TestRedis } from '@onebox/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLease } from './lease';

let container: TestRedis;
let redis: Redis;

beforeAll(async () => {
  container = await startRedis();
  redis = new Redis(container.url);
});

afterAll(async () => {
  redis.disconnect();
  await container.stop();
});

describe('account lease', () => {
  it('has a single owner at a time', async () => {
    const a = createLease(redis, 'acc-1', 'pod-a');
    const b = createLease(redis, 'acc-1', 'pod-b');
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
  });

  it('only lets the owner renew or release', async () => {
    const a = createLease(redis, 'acc-2', 'pod-a');
    const b = createLease(redis, 'acc-2', 'pod-b');
    await a.acquire();
    expect(await b.renew()).toBe(false);
    expect(await b.release()).toBe(false);
    expect(await a.renew()).toBe(true);
    expect(await a.release()).toBe(true);
    expect(await b.acquire()).toBe(true);
  });

  it('expires when the owner stops renewing', async () => {
    const a = createLease(redis, 'acc-3', 'pod-a', 100);
    const b = createLease(redis, 'acc-3', 'pod-b', 100);
    await a.acquire();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await b.acquire()).toBe(true);
    expect(await a.renew()).toBe(false);
  });
});
