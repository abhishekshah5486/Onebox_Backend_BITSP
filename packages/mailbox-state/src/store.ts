import {
  historyStateSchema,
  mailboxCountsSchema,
  mailboxKeys,
  type HistoryState,
  type MailboxCounts,
} from '@onebox/contracts';
import type { Redis } from 'ioredis';
import type { z } from 'zod';

// Derived, rebuildable state: losing it only means counts refresh on the next connector sync.
const TTL_SECONDS = 7 * 24 * 60 * 60;

async function read<S extends z.ZodType>(
  redis: Redis,
  key: string,
  schema: S,
): Promise<z.infer<S> | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  const parsed = schema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export function createMailboxStore(redis: Redis) {
  return {
    setCounts: (counts: MailboxCounts) =>
      redis.set(
        mailboxKeys.counts(counts.accountId, counts.folder),
        JSON.stringify(counts),
        'EX',
        TTL_SECONDS,
      ),

    getCounts: (accountId: string, folder: string) =>
      read(redis, mailboxKeys.counts(accountId, folder), mailboxCountsSchema),

    setHistory: (
      accountId: string,
      folder: string,
      status: HistoryState['status'],
      error: string | null = null,
    ) =>
      redis.set(
        mailboxKeys.history(accountId, folder),
        JSON.stringify({ status, error, updatedAt: new Date().toISOString() }),
        'EX',
        TTL_SECONDS,
      ),

    getHistory: (accountId: string, folder: string) =>
      read(redis, mailboxKeys.history(accountId, folder), historyStateSchema),
  };
}

export type MailboxStore = ReturnType<typeof createMailboxStore>;
