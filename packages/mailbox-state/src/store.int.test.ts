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
      role: 'inbox' as const,
      folder: 'INBOX',
      uidValidity: 7,
      total: 4586,
      unread: 12,
      updatedAt: '2026-10-07T10:00:00.000Z',
    };
    await store.setCounts(counts);
    await store.setHistory('a1', 'inbox', 'error', 'Gmail rejected the sign-in');

    expect(await store.getCounts('a1', 'inbox')).toEqual(counts);
    expect(await store.getHistory('a1', 'inbox')).toMatchObject({
      status: 'error',
      error: 'Gmail rejected the sign-in',
    });
    expect(await redis.ttl(mailboxKeys.counts('a1', 'inbox'))).toBeGreaterThan(0);
  });

  it('keeps label counts apart by path and stores the label list', async () => {
    const store = createMailboxStore(redis);
    const label = (folder: string, total: number) => ({
      userId: 'u1',
      accountId: 'a3',
      role: 'label' as const,
      folder,
      uidValidity: 1,
      total,
      unread: 0,
      updatedAt: '2026-10-07T10:00:00.000Z',
    });
    await store.setCounts(label('Work', 3));
    await store.setCounts(label('Travel', 9));
    await store.setLabels('a3', [
      { path: 'Work', name: 'Work' },
      { path: 'Travel', name: 'Travel' },
    ]);

    expect(await store.getCounts('a3', 'label:Work')).toMatchObject({ total: 3 });
    expect(await store.getCounts('a3', 'label:Travel')).toMatchObject({ total: 9 });
    expect((await store.getLabels('a3')).map((l) => l.path)).toEqual(['Work', 'Travel']);
    expect(await store.getLabels('none')).toEqual([]);
  });

  it('returns null for missing or corrupted entries', async () => {
    const store = createMailboxStore(redis);
    expect(await store.getCounts('missing', 'inbox')).toBeNull();
    await redis.set(mailboxKeys.history('a2', 'inbox'), JSON.stringify({ status: 'weird' }));
    expect(await store.getHistory('a2', 'inbox')).toBeNull();
  });
});
