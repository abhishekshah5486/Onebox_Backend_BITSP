import type { Redis } from 'ioredis';

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

// One live IMAP connection per mailbox across all connector replicas.
export function createLease(redis: Redis, accountId: string, ownerId: string, ttlMs = 30_000) {
  const key = `lease:account:${accountId}`;
  return {
    acquire: async () => (await redis.set(key, ownerId, 'PX', ttlMs, 'NX')) === 'OK',
    renew: async () => (await redis.eval(RENEW, 1, key, ownerId, String(ttlMs))) === 1,
    release: async () => (await redis.eval(RELEASE, 1, key, ownerId)) === 1,
  };
}

export type Lease = ReturnType<typeof createLease>;
