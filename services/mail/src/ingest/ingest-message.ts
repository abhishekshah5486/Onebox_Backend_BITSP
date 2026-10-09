import type { IngestPayload, JobEnvelope } from '@onebox/contracts';
import { isDuplicateKeyError } from '@onebox/db-mongo';
import { ValidationError } from '@onebox/errors';
import type { JobContext } from '@onebox/queue';
import type { MailCollections, MessageDoc } from '../db/collections';
import { mergeRelatedThreads, refreshThread, resolveThreadId } from '../threads/thread-store';
import type { BlobStore } from '@onebox/blob-store';
import { storeAttachments } from '../attachments/attachments';
import { parseMail } from './parse';

// Called once for each message newly stored from the inbox as it arrives (not history).
export type OnNewMail = (doc: MessageDoc) => Promise<void>;

// With a blob store, attachment contents are kept as mail arrives.
export function createIngestHandler(
  collections: MailCollections,
  onNewMail?: OnNewMail,
  blobs?: BlobStore,
) {
  const { messages } = collections;

  return async (envelope: JobEnvelope<IngestPayload>, { logger }: JobContext) => {
    const { jobId: dedupeKey, userId, accountId, payload } = envelope;
    if (!accountId) throw new ValidationError('Ingest job is missing accountId');

    const existing = await messages.findOne({ _id: dedupeKey }, { projection: { threadId: 1 } });
    if (existing) {
      await refreshThread(collections, existing.threadId);
      logger.debug({ threadId: existing.threadId }, 'message already stored');
      return;
    }

    let parsed;
    let files: Buffer[];
    try {
      ({ message: parsed, files } = await parseMail(Buffer.from(payload.rawSource, 'base64')));
    } catch (err) {
      throw new ValidationError('Message could not be parsed', { cause: err });
    }
    if (blobs && parsed.attachments.length > 0) {
      parsed.attachments = await storeAttachments(blobs, userId, parsed.attachments, files, logger);
    }

    const receivedAt = payload.internalDate
      ? new Date(payload.internalDate)
      : (parsed.sentAt ?? new Date());
    const threadId = await resolveThreadId(collections, {
      userId,
      accountId,
      dedupeKey,
      messageIdHeader: parsed.messageIdHeader,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      subject: parsed.subject,
      receivedAt,
    });

    let inserted = false;
    try {
      await messages.insertOne({
        _id: dedupeKey,
        userId,
        accountId,
        threadId,
        folder: payload.folder,
        role: payload.role,
        uid: payload.uid,
        uidValidity: payload.uidValidity,
        ...parsed,
        flags: payload.flags,
        isRead: payload.flags.includes('\\Seen'),
        isStarred: payload.flags.includes('\\Flagged'),
        receivedAt,
        sizeBytes: payload.sizeBytes,
        backfill: payload.backfill,
        category: payload.category,
        categories: payload.categories,
        pendingSince: null,
        movingTo: null,
        createdAt: new Date(),
      });
      inserted = true;
    } catch (err) {
      // A concurrent delivery of the same job already stored it.
      if (!isDuplicateKeyError(err)) throw err;
    }

    const finalThreadId = await mergeRelatedThreads(
      collections,
      { userId, accountId, dedupeKey, ...parsed },
      threadId,
    );
    await refreshThread(collections, finalThreadId);
    if (inserted && onNewMail && !payload.backfill && payload.role === 'inbox') {
      const doc = await messages.findOne({ _id: dedupeKey });
      if (doc) await onNewMail(doc);
    }
    logger[payload.backfill ? 'debug' : 'info'](
      { threadId: finalThreadId, role: payload.role, backfill: payload.backfill },
      'message stored',
    );
  };
}
