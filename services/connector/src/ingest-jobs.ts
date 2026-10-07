import {
  createJobEnvelope,
  type FolderRole,
  ingestDedupeKey,
  MAX_RAW_MESSAGE_BYTES,
  type IngestPayload,
  type JobEnvelope,
} from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import type { Producer } from '@onebox/queue';
import type { FetchMessageObject, ImapFlow } from 'imapflow';

export interface FolderRef {
  path: string;
  role: FolderRole;
}

export function toIngestEnvelope(
  account: { id: string; userId: string },
  folder: FolderRef,
  uidValidity: number,
  message: FetchMessageObject,
  backfill: boolean,
): JobEnvelope<IngestPayload> | null {
  if (!message.source || message.source.length > MAX_RAW_MESSAGE_BYTES) return null;
  return createJobEnvelope({
    jobId: ingestDedupeKey({
      accountId: account.id,
      folder: folder.path,
      uidValidity,
      uid: message.uid,
    }),
    userId: account.userId,
    accountId: account.id,
    payload: {
      folder: folder.path,
      role: folder.role,
      uid: message.uid,
      uidValidity,
      flags: [...(message.flags ?? [])],
      internalDate: message.internalDate ? new Date(message.internalDate).toISOString() : null,
      sizeBytes: message.size ?? message.source.length,
      backfill,
      rawSource: message.source.toString('base64'),
    },
  });
}

// Caller must hold the mailbox lock. BODY.PEEK keeps the fetch from marking anything read.
export async function fetchAndEnqueue(
  client: ImapFlow,
  range: number[] | string,
  options: {
    account: { id: string; userId: string };
    folder: FolderRef;
    uidValidity: number;
    byUid: boolean;
    backfill: boolean;
    producer: Producer<IngestPayload>;
    logger: Logger;
  },
): Promise<{ uids: number[]; jobIds: string[] }> {
  const uids: number[] = [];
  const jobIds: string[] = [];
  for await (const message of client.fetch(
    range,
    { uid: true, flags: true, internalDate: true, size: true, source: true },
    { uid: options.byUid },
  )) {
    uids.push(message.uid);
    const envelope = toIngestEnvelope(
      options.account,
      options.folder,
      options.uidValidity,
      message,
      options.backfill,
    );
    if (!envelope) {
      options.logger.warn(
        { uid: message.uid, sizeBytes: message.size },
        'skipping message that is too large',
      );
      continue;
    }
    await options.producer.enqueue(envelope);
    jobIds.push(envelope.jobId);
  }
  return { uids, jobIds };
}
