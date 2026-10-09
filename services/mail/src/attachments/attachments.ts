import type { BlobStore } from '@onebox/blob-store';
import { createJobEnvelope, type MailboxOpPayload } from '@onebox/contracts';
import { ExternalServiceError, NotFoundError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Producer } from '@onebox/queue';
import type { Readable } from 'node:stream';
import type { AttachmentMeta, MailCollections, MessageDoc } from '../db/collections';
import { parseMail } from '../ingest/parse';

// Larger files stay on the mail server; Gmail itself caps attachments at 25 MB.
const MAX_STORED_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

// Named by content, so the same file sent many times is stored once per user.
export const attachmentKey = (userId: string, sha256: string) => `attachments/${userId}/${sha256}`;

// Puts each attachment's contents in the blob store. One that fails to upload is left to be
// fetched from the mail server when someone opens it.
export async function storeAttachments(
  blobs: BlobStore,
  userId: string,
  metas: AttachmentMeta[],
  files: Buffer[],
  logger: Logger,
): Promise<AttachmentMeta[]> {
  return Promise.all(
    metas.map(async (meta, i) => {
      const content = files[i];
      if (!content || !meta.sha256 || content.length > MAX_STORED_BYTES) return meta;
      try {
        await blobs.put(attachmentKey(userId, meta.sha256), content, meta.contentType);
        return { ...meta, stored: true };
      } catch (err) {
        logger.warn({ err }, 'attachment not stored; it will be fetched when opened');
        return meta;
      }
    }),
  );
}

async function readAll(body: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function createAttachmentService({
  collections,
  blobs,
  ops,
  logger,
}: {
  collections: MailCollections;
  blobs: BlobStore;
  ops: Producer<MailboxOpPayload>;
  logger: Logger;
}) {
  const { messages } = collections;

  // Mail stored before contents were kept: the connector copies the raw message into the blob
  // store, its attachments are saved, and the copy is removed.
  async function fetchFromServer(doc: MessageDoc) {
    const key = `raw/${doc._id}`;
    const jobId = `source-${doc._id}-${Date.now()}`;
    await ops.enqueue(
      createJobEnvelope<MailboxOpPayload>({
        jobId,
        userId: doc.userId,
        accountId: doc.accountId,
        payload: {
          kind: 'source',
          folder: doc.folder,
          uidValidity: doc.uidValidity,
          uid: doc.uid,
          key,
        },
      }),
    );
    const outcome = await ops.outcome(jobId, { timeoutMs: FETCH_TIMEOUT_MS });
    const raw = outcome.status === 'completed' ? await blobs.get(key) : null;
    if (!raw) {
      throw new ExternalServiceError('This attachment could not be fetched from the mail server');
    }
    const { message, files } = await parseMail(await readAll(raw.body));
    const attachments = await storeAttachments(
      blobs,
      doc.userId,
      message.attachments,
      files,
      logger,
    );
    await messages.updateOne({ _id: doc._id }, { $set: { attachments } });
    await blobs.remove(key).catch(() => {});
    logger.info({ count: attachments.length }, 'attachments fetched from the mail server');
    return attachments;
  }

  return {
    async open(userId: string, messageId: string, index: number) {
      const doc = await messages.findOne({ _id: messageId, userId });
      if (!doc) throw new NotFoundError('Message not found');
      let meta = doc.attachments[index];
      if (!meta) throw new NotFoundError('Attachment not found');
      if (!meta.stored || !meta.sha256) meta = (await fetchFromServer(doc))[index];
      const blob = meta?.sha256 ? await blobs.get(attachmentKey(userId, meta.sha256)) : null;
      if (!meta || !blob) throw new NotFoundError('This attachment is not available');
      return { meta, blob };
    },
  };
}

export type AttachmentService = ReturnType<typeof createAttachmentService>;
