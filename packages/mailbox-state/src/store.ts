import {
  historyStateSchema,
  mailboxCountsSchema,
  mailboxKey,
  mailboxKeys,
  mailboxLabelSchema,
  type HistoryState,
  type MailboxCounts,
  type MailboxLabel,
} from '@onebox/contracts';
import type { Redis } from 'ioredis';
import { z } from 'zod';

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
        mailboxKeys.counts(counts.accountId, mailboxKey(counts.role, counts.folder)),
        JSON.stringify(counts),
        'EX',
        TTL_SECONDS,
      ),

    // `key` is a folder role or `label:<path>` (mailboxKey).
    getCounts: (accountId: string, key: string) =>
      read(redis, mailboxKeys.counts(accountId, key), mailboxCountsSchema),

    setHistory: (
      accountId: string,
      key: string,
      status: HistoryState['status'],
      error: string | null = null,
      cursor?: HistoryState['cursor'],
    ) =>
      redis.set(
        mailboxKeys.history(accountId, key),
        JSON.stringify({ status, error, updatedAt: new Date().toISOString(), cursor }),
        'EX',
        TTL_SECONDS,
      ),

    getHistory: (accountId: string, key: string) =>
      read(redis, mailboxKeys.history(accountId, key), historyStateSchema),

    setLabels: (accountId: string, labels: MailboxLabel[]) =>
      redis.set(mailboxKeys.labels(accountId), JSON.stringify(labels), 'EX', TTL_SECONDS),

    getLabels: async (accountId: string) =>
      (await read(redis, mailboxKeys.labels(accountId), z.array(mailboxLabelSchema))) ?? [],
  };
}

export type MailboxStore = ReturnType<typeof createMailboxStore>;
