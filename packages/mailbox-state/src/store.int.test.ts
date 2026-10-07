import { mailboxKeys } from '@onebox/contracts';
import { startRedis, type TestRedis } from '@onebox/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMailboxStore } from './store';

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

describe('mailbox store', () => {
  it('round-trips counts and history state with an expiry', async () => {
    const store = createMailboxStore(redis);
    const counts = {
      userId: 'u1',
      accountId: 'a1',
      folder: 'INBOX',
      uidValidity: 7,
      total: 4586,
      unread: 12,
      updatedAt: '2026-10-07T10:00:00.000Z',
    };
    await store.setCounts(counts);
    await store.setHistory('a1', 'INBOX', 'error', 'Gmail rejected the sign-in');

    expect(await store.getCounts('a1', 'INBOX')).toEqual(counts);
    expect(await store.getHistory('a1', 'INBOX')).toMatchObject({
      status: 'error',
      error: 'Gmail rejected the sign-in',
    });
    expect(await redis.ttl(mailboxKeys.counts('a1', 'INBOX'))).toBeGreaterThan(0);
  });

  it('returns null for missing or corrupted entries', async () => {
    const store = createMailboxStore(redis);
    expect(await store.getCounts('missing', 'INBOX')).toBeNull();
    await redis.set(mailboxKeys.history('a2', 'INBOX'), JSON.stringify({ status: 'weird' }));
    expect(await store.getHistory('a2', 'INBOX')).toBeNull();
  });
});
