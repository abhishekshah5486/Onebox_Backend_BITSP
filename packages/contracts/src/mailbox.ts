import { z } from 'zod';
import { mailboxRoleSchema } from './folders';

export const HISTORY_BATCH_SIZE = 50;

// Fetch up to `count` messages older than `beforeUid`; uidValidity guards against a renumbered folder.
export const historyPayloadSchema = z.object({
  folder: z.string().min(1),
  role: mailboxRoleSchema,
  uidValidity: z.number().int().nonnegative(),
  beforeUid: z.number().int().positive(),
  count: z.number().int().min(1).max(200),
});

export type HistoryPayload = z.infer<typeof historyPayloadSchema>;

// Server-side counts published by the connector (cached in Redis, cheap IMAP STATUS).
export const mailboxCountsSchema = z.object({
  userId: z.string(),
  accountId: z.string(),
  role: mailboxRoleSchema,
  // The provider's actual IMAP path for this role, e.g. "[Gmail]/Sent Mail".
  folder: z.string(),
  uidValidity: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});

export type MailboxCounts = z.infer<typeof mailboxCountsSchema>;

export const HISTORY_STATUSES = ['idle', 'fetching', 'complete', 'error'] as const;

export const historyStateSchema = z.object({
  status: z.enum(HISTORY_STATUSES),
  error: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export type HistoryState = z.infer<typeof historyStateSchema>;

// The user's own folders or Gmail labels, as found by the connector.
export const mailboxLabelSchema = z.object({ path: z.string().min(1), name: z.string() });

export type MailboxLabel = z.infer<typeof mailboxLabelSchema>;

// `key` is a folder role, or `label:<path>` for a label (see mailboxKey).
export const mailboxKeys = {
  counts: (accountId: string, key: string) => `mailbox:counts:${accountId}:${key}`,
  history: (accountId: string, key: string) => `mailbox:history:${accountId}:${key}`,
  labels: (accountId: string) => `mailbox:labels:${accountId}`,
};
