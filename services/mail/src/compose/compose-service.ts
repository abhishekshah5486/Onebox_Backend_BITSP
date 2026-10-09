import { randomUUID } from 'node:crypto';
import {
  createJobEnvelope,
  MAX_SEND_BYTES,
  type OutgoingAttachment,
  type Recipient,
  type SendPayload,
} from '@onebox/contracts';
import { ConflictError, NotFoundError, ValidationError } from '@onebox/errors';
import type { BlobStore } from '@onebox/blob-store';
import type { Logger } from '@onebox/logger';
import type { Producer } from '@onebox/queue';
import { attachmentKey, type AttachmentService } from '../attachments/attachments';
import type { MailCollections } from '../db/collections';
import type { AccountsClient } from './accounts-client';
import type { ComposeCollections, Composition, DraftDoc, OutboxDoc } from './collections';

// How long a sent message waits, so it can still be undone.
export const DEFAULT_UNDO_SECONDS = 5;
const MAX_REFERENCES = 20;
const MIN_SCHEDULE_MS = 60_000;
const MAX_SCHEDULE_MS = 365 * 24 * 3600_000;
const CONTACT_SCAN = 3_000;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const draftView = (doc: DraftDoc) => ({
  id: doc._id,
  accountId: doc.accountId,
  to: doc.to,
  cc: doc.cc,
  bcc: doc.bcc,
  subject: doc.subject,
  html: doc.html,
  text: doc.text,
  attachments: doc.attachments,
  replyTo: doc.replyTo,
  note: doc.note,
  updatedAt: doc.updatedAt.toISOString(),
});

export const outboxView = (doc: OutboxDoc) => ({
  id: doc._id,
  accountId: doc.accountId,
  threadId: doc.threadId,
  to: doc.to,
  subject: doc.subject,
  status: doc.status,
  error: doc.error,
  sendAt: doc.sendAt.toISOString(),
  sentAt: doc.sentAt?.toISOString() ?? null,
  createdAt: doc.createdAt.toISOString(),
});

const composition = (input: Composition): Composition => ({
  accountId: input.accountId,
  to: input.to,
  cc: input.cc,
  bcc: input.bcc,
  subject: input.subject,
  html: input.html,
  text: input.text,
  attachments: input.attachments,
  replyTo: input.replyTo,
});

export function createComposeService({
  collections,
  mail,
  blobs,
  attachments,
  accounts,
  sends,
  logger,
}: {
  collections: ComposeCollections;
  mail: MailCollections;
  blobs: BlobStore;
  attachments: AttachmentService;
  accounts: AccountsClient;
  sends: Pick<Producer<SendPayload>, 'enqueue' | 'cancel'>;
  logger: Logger;
}) {
  const { drafts, outbox } = collections;

  // Only the user's own uploads and stored attachments can go out with their mail.
  function checkAttachments(userId: string, list: OutgoingAttachment[]) {
    for (const attachment of list) {
      const own = [`uploads/${userId}/`, `attachments/${userId}/`];
      if (!own.some((prefix) => attachment.blobKey.startsWith(prefix))) {
        throw new ValidationError(`The attachment ${attachment.filename} is not available`);
      }
    }
  }

  async function saveDraft(userId: string, id: string, input: Composition, note: string | null) {
    const now = new Date();
    await drafts.updateOne(
      { _id: id, userId },
      { $set: { ...composition(input), note, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    return draftView((await drafts.findOne({ _id: id, userId }))!);
  }

  return {
    async listDrafts(userId: string) {
      const docs = await drafts.find({ userId }).sort({ updatedAt: -1 }).limit(200).toArray();
      return docs.map(draftView);
    },

    async getDraft(userId: string, id: string) {
      const doc = await drafts.findOne({ _id: id, userId });
      if (!doc) throw new NotFoundError('Draft not found');
      return draftView(doc);
    },

    // Creates the draft on first save, so the editor can save under an id it picked.
    async putDraft(userId: string, id: string, input: Composition) {
      checkAttachments(userId, input.attachments);
      const existing = await drafts.findOne({ _id: id }, { projection: { userId: 1 } });
      if (existing && existing.userId !== userId) throw new NotFoundError('Draft not found');
      return saveDraft(userId, id, input, null);
    },

    async deleteDraft(userId: string, id: string) {
      await drafts.deleteOne({ _id: id, userId });
    },

    // A file the user attached, kept until the message is sent.
    async upload(userId: string, file: { filename: string; contentType: string; body: Buffer }) {
      if (file.body.length === 0) throw new ValidationError('The file is empty');
      if (file.body.length > MAX_SEND_BYTES) {
        throw new ValidationError('Attachments can be up to 25 MB in total');
      }
      const blobKey = `uploads/${userId}/${randomUUID()}`;
      await blobs.put(blobKey, file.body, file.contentType);
      return {
        blobKey,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.body.length,
      } satisfies OutgoingAttachment;
    },

    // An attachment of a stored message, to forward it.
    async attachFromMessage(userId: string, messageId: string, index: number) {
      const { meta } = await attachments.open(userId, messageId, index);
      return {
        blobKey: attachmentKey(userId, meta.sha256!),
        filename: meta.filename,
        contentType: meta.contentType,
        sizeBytes: meta.sizeBytes,
      } satisfies OutgoingAttachment;
    },

    // Queues a message; it goes out after the undo window unless cancelled.
    async send(
      userId: string,
      input: Composition & {
        draftId?: string | undefined;
        undoSeconds?: number | undefined;
        // Scheduled send: goes out at this time instead (and can be cancelled until then).
        sendAt?: string | undefined;
      },
    ) {
      if (!input.accountId) throw new ValidationError('Choose the account to send from');
      if (input.to.length + input.cc.length + input.bcc.length === 0) {
        throw new ValidationError('Add at least one recipient');
      }
      checkAttachments(userId, input.attachments);
      const size =
        input.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0) +
        input.html.length;
      if (size > MAX_SEND_BYTES) {
        throw new ValidationError('This message is over 25 MB. Remove some attachments.');
      }
      const account = await accounts(input.accountId);
      if (account.userId !== userId) throw new NotFoundError('That account was not found');
      if (account.status === 'DISABLED') {
        throw new ValidationError('That account is paused. Turn it back on in Accounts.');
      }

      let threadId: string | null = null;
      let inReplyTo: string | null = null;
      let references: string[] = [];
      if (input.replyTo) {
        const original = await mail.messages.findOne({ _id: input.replyTo.messageId, userId });
        if (!original) throw new NotFoundError('The message you are replying to is gone');
        threadId = original.threadId;
        if (original.messageIdHeader) {
          inReplyTo = original.messageIdHeader;
          references = [...original.references, original.messageIdHeader].slice(-MAX_REFERENCES);
        }
      }

      const id = randomUUID();
      const domain = account.emailAddress.split('@')[1] ?? 'onebox.app';
      const now = new Date();
      let delayMs = (input.undoSeconds ?? DEFAULT_UNDO_SECONDS) * 1000;
      if (input.sendAt) {
        const at = new Date(input.sendAt).getTime() - now.getTime();
        if (at < MIN_SCHEDULE_MS || at > MAX_SCHEDULE_MS) {
          throw new ValidationError('Schedule it for at least a minute from now and within a year');
        }
        delayMs = at;
      }
      const doc: OutboxDoc = {
        _id: id,
        userId,
        ...composition(input),
        accountId: input.accountId,
        messageId: `<${id}@${domain}>`,
        inReplyTo,
        references,
        threadId,
        status: 'scheduled',
        error: null,
        sendAt: new Date(now.getTime() + delayMs),
        sentAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await outbox.insertOne(doc);
      await sends.enqueue(
        createJobEnvelope<SendPayload>({
          jobId: `send-${id}`,
          userId,
          accountId: input.accountId,
          payload: {
            outboxId: id,
            messageId: doc.messageId,
            to: doc.to,
            cc: doc.cc,
            bcc: doc.bcc,
            subject: doc.subject,
            html: doc.html,
            text: doc.text,
            inReplyTo,
            references,
            attachments: doc.attachments,
          },
        }),
        { delayMs },
      );
      if (input.draftId) await drafts.deleteOne({ _id: input.draftId, userId });
      logger.info(
        { outboxId: id, recipients: doc.to.length + doc.cc.length + doc.bcc.length },
        'message queued',
      );
      return outboxView(doc);
    },

    // Undo: stops a message that hasn't gone yet and gives it back as a draft.
    async cancel(userId: string, id: string) {
      const doc = await outbox.findOne({ _id: id, userId });
      if (!doc) throw new NotFoundError('That message was not found');
      const withdrawn = doc.status === 'scheduled' ? await sends.cancel([`send-${id}`]) : null;
      if (!withdrawn)
        throw new ConflictError('This message has already been sent', { code: 'ALREADY_SENT' });
      await outbox.updateOne({ _id: id }, { $set: { status: 'cancelled', updatedAt: new Date() } });
      return saveDraft(userId, randomUUID(), doc, null);
    },

    // The connector's word on a message: sent, or failed (it comes back as a draft to fix).
    async applyResult(outboxId: string, status: 'sent' | 'failed', error: string | null) {
      const doc = await outbox.findOneAndUpdate(
        { _id: outboxId, status: 'scheduled' },
        {
          $set: {
            status,
            error,
            ...(status === 'sent' && { sentAt: new Date() }),
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' },
      );
      if (!doc) return;
      if (status === 'failed') {
        await saveDraft(
          doc.userId,
          `failed-${doc._id}`,
          doc,
          error ?? "This message couldn't be sent",
        );
      }
      logger.info({ outboxId, status }, 'send finished');
    },

    async listOutbox(userId: string) {
      const docs = await outbox.find({ userId }).sort({ createdAt: -1 }).limit(50).toArray();
      return docs.map(outboxView);
    },

    // People the user has written to or heard from, for the To field; frequent ones first.
    async contacts(userId: string, query: string) {
      const pattern = new RegExp(escapeRegex(query.trim()), 'i');
      const people = await mail.messages
        .aggregate<{ _id: string; name: string; count: number; last: Date }>([
          { $match: { userId } },
          { $sort: { receivedAt: -1 } },
          { $limit: CONTACT_SCAN },
          { $project: { people: { $concatArrays: [['$from'], '$to', '$cc'] }, receivedAt: 1 } },
          { $unwind: '$people' },
          { $match: { 'people.address': { $type: 'string' } } },
          {
            $match: query.trim()
              ? { $or: [{ 'people.address': pattern }, { 'people.name': pattern }] }
              : {},
          },
          {
            $group: {
              _id: { $toLower: '$people.address' },
              name: { $first: '$people.name' },
              count: { $sum: 1 },
              last: { $max: '$receivedAt' },
            },
          },
          { $sort: { count: -1, last: -1 } },
          { $limit: 8 },
        ])
        .toArray();
      return people.map(
        (person) => ({ name: person.name || null, address: person._id }) satisfies Recipient,
      );
    },
  };
}

export type ComposeService = ReturnType<typeof createComposeService>;
