import { randomUUID } from 'node:crypto';
import type { SearchDocument } from '@onebox/contracts';
import { ServiceUnavailableError } from '@onebox/errors';
import type { Redis } from 'ioredis';

// Long enough for both queues to see a removal, short enough not to pile up.
const FORGET_AFTER_S = 24 * 3600;
const LOCK_MS = 60_000;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

export type IndexStateStore = Pick<Redis, 'get' | 'mget' | 'set' | 'mset' | 'expire' | 'eval'>;

// What both indexes share in Redis: which email a copy belongs to, copies already removed
// (so a late, older write can't bring one back), and a per-email lock.
export function createIndexState(redis: IndexStateStore) {
  const copyKey = (messageId: string) => `search:copy:${messageId}`;
  const goneKey = (messageId: string) => `search:gone:${messageId}`;

  return {
    async rememberCopies(doc: SearchDocument) {
      await redis.mset(...doc.copies.flatMap((copy) => [copyKey(copy.messageId), doc.key]));
    },

    keyOfCopy: (messageId: string) => redis.get(copyKey(messageId)),

    async forgetCopy(messageId: string, version: number) {
      await redis.set(goneKey(messageId), String(version), 'EX', FORGET_AFTER_S);
      await redis.expire(copyKey(messageId), FORGET_AFTER_S);
    },

    // The email without copies removed after this version was taken; null if none are left.
    async withoutRemoved(doc: SearchDocument, version: number): Promise<SearchDocument | null> {
      const gone = await redis.mget(...doc.copies.map((copy) => goneKey(copy.messageId)));
      const copies = doc.copies.filter((_, i) => gone[i] == null || Number(gone[i]) < version);
      return copies.length > 0 ? { ...doc, copies } : null;
    },

    // Busy means another worker has this email; the job is retried shortly.
    async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const lock = `search:lock:${name}`;
      const token = randomUUID();
      if ((await redis.set(lock, token, 'PX', LOCK_MS, 'NX')) !== 'OK') {
        throw new ServiceUnavailableError('Email is being indexed', { code: 'INDEX_BUSY' });
      }
      try {
        return await fn();
      } finally {
        await redis.eval(RELEASE, 1, lock, token);
      }
    },
  };
}

export type IndexState = ReturnType<typeof createIndexState>;

// Label folders count as labels, alongside the AI's.
export const labelsOf = (doc: Pick<SearchDocument, 'labels' | 'copies'>) => [
  ...new Set([
    ...doc.labels,
    ...doc.copies.filter((copy) => copy.role === 'label').map((copy) => copy.folder),
  ]),
];
