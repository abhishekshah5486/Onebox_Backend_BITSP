import { createHash } from 'node:crypto';
import { z } from 'zod';

// Messages above this size are skipped by the connector rather than queued.
export const MAX_RAW_MESSAGE_BYTES = 25 * 1024 * 1024;

export const ingestPayloadSchema = z.object({
  folder: z.string().min(1),
  uid: z.number().int().positive(),
  uidValidity: z.number().int().nonnegative(),
  flags: z.array(z.string()),
  internalDate: z.iso.datetime().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  // Backfilled mail must never trigger alerts or automations meant for new mail.
  backfill: z.boolean(),
  rawSource: z.base64().max(Math.ceil((MAX_RAW_MESSAGE_BYTES * 4) / 3) + 4),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

// Stable across reconnects and replays: the same IMAP message always gets the same key.
export function ingestDedupeKey(input: {
  accountId: string;
  folder: string;
  uidValidity: number;
  uid: number;
}): string {
  return createHash('sha256')
    .update([input.accountId, input.folder, input.uidValidity, input.uid].join('\u0000'))
    .digest('hex');
}
