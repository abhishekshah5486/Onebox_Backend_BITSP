import type { BlobStore } from '@onebox/blob-store';
import type {
  IngestPayload,
  JobEnvelope,
  MailboxChangePayload,
  Recipient,
  SendPayload,
} from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import { resolvePublicHost } from '@onebox/net-guard';
import type { JobContext, Producer } from '@onebox/queue';
import type { Readable } from 'node:stream';
import type { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { changeEnvelope } from './folder-sync';
import { discoverFolders } from './folders';
import { AuthenticationFailedError, openImapClient } from './imap-client';
import { fetchAndEnqueue } from './ingest-jobs';
import type { AccountCredentials, InternalClient } from './internal-client';

export interface SendDeps {
  internal: InternalClient;
  changes: Pick<Producer<MailboxChangePayload>, 'enqueue'>;
  ingest: Producer<IngestPayload>;
  blobs: BlobStore;
  // Remembers which messages the SMTP server accepted, so a retry never sends one twice.
  accepted: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  };
  allowPrivateHosts: boolean;
  // Off only for test servers that can't upgrade a connection to TLS.
  requireStartTls?: boolean;
  connectTimeoutMs?: number;
  maxAttempts: number;
  // How long to wait for the provider to file its own copy in Sent before adding one.
  sentCopyWaitMs?: number;
}

const ACCEPTED_TTL_S = 7 * 24 * 3600;
// Plain IMAP servers may have no Sent folder; like most mail apps, OneBox creates one.
const SENT_FOLDER = 'Sent';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const readAll = async (body: Readable) => Buffer.concat((await body.toArray()) as Buffer[]);
const mailbox = (recipient: Recipient) =>
  recipient.name ? { name: recipient.name, address: recipient.address } : recipient.address;

// A problem retrying won't fix: the message fails and the user is told why.
class SendRefused extends Error {}

// The message exactly as sent. Built once and kept, so every retry and the Sent copy match.
async function rawMessage(
  payload: SendPayload,
  sender: AccountCredentials,
  blobs: BlobStore,
): Promise<Buffer> {
  const key = `outbox/${payload.outboxId}.eml`;
  const kept = await blobs.get(key);
  if (kept) return readAll(kept.body);
  const attachments = await Promise.all(
    payload.attachments.map(async (attachment) => {
      const blob = await blobs.get(attachment.blobKey);
      if (!blob)
        throw new SendRefused(`The attachment ${attachment.filename} is no longer available`);
      return {
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: await readAll(blob.body),
      };
    }),
  );
  const raw = await new MailComposer({
    from: sender.displayName
      ? { name: sender.displayName, address: sender.emailAddress }
      : sender.emailAddress,
    to: payload.to.map(mailbox),
    cc: payload.cc.map(mailbox),
    // Bcc recipients get the message through the envelope; the header is left out.
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    messageId: payload.messageId,
    ...(payload.inReplyTo && { inReplyTo: payload.inReplyTo }),
    ...(payload.references.length > 0 && { references: payload.references }),
    date: new Date(),
    attachments,
  })
    .compile()
    .build();
  await blobs.put(key, raw, 'message/rfc822');
  return raw;
}

async function smtpSend(
  raw: Buffer,
  payload: SendPayload,
  sender: AccountCredentials,
  deps: SendDeps,
) {
  if (!sender.smtp) throw new SendRefused('This account has no outgoing mail server set up');
  const resolved = await resolvePublicHost(sender.smtp.host, {
    allowPrivate: deps.allowPrivateHosts,
  });
  const timeoutMs = deps.connectTimeoutMs ?? 30_000;
  const transport = nodemailer.createTransport({
    host: resolved.address,
    port: sender.smtp.port,
    // tls=false is STARTTLS on the submission port, which must then be upgraded.
    secure: sender.smtp.tls,
    requireTLS: !sender.smtp.tls && (deps.requireStartTls ?? true),
    ignoreTLS: !sender.smtp.tls && deps.requireStartTls === false,
    tls: { servername: sender.smtp.host, rejectUnauthorized: true },
    auth: { user: sender.username, pass: sender.password },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
  });
  try {
    await transport.sendMail({
      envelope: {
        from: sender.emailAddress,
        to: [...payload.to, ...payload.cc, ...payload.bcc].map((r) => r.address),
      },
      raw,
    });
  } catch (err) {
    const error = err as { code?: string; responseCode?: number; response?: string };
    if (error.code === 'EAUTH') {
      throw new SendRefused(
        "The mail server didn't accept this account's password for sending. Check it in Accounts.",
      );
    }
    // 5xx: the server refused for good (e.g. an unknown recipient or a message too large).
    if (error.code === 'EENVELOPE' || (error.responseCode && error.responseCode >= 500)) {
      throw new SendRefused(error.response?.slice(0, 300) ?? 'The mail server refused the message');
    }
    throw err;
  } finally {
    transport.close();
  }
}

// Makes sure the sent message is in the account's Sent folder (most providers file it
// themselves), then has it stored at once so it shows in its conversation.
async function fileSentCopy(
  client: ImapFlow,
  raw: Buffer,
  envelope: JobEnvelope<SendPayload>,
  deps: SendDeps,
  logger: JobContext['logger'],
) {
  const entries = await client.list();
  let path = discoverFolders(entries).folders.find((folder) => folder.role === 'sent')?.path;
  if (!path) {
    await client.mailboxCreate(SENT_FOLDER);
    path = SENT_FOLDER;
  }
  const find = async () => {
    const lock = await client.getMailboxLock(path);
    try {
      const uids = await client.search(
        { header: { 'message-id': envelope.payload.messageId } },
        { uid: true },
      );
      return {
        uids: uids || [],
        uidValidity: Number(client.mailbox && client.mailbox.uidValidity),
      };
    } finally {
      lock.release();
    }
  };

  let found = await find();
  // The provider may take a moment to file its own copy.
  for (let tries = 0; found.uids.length === 0 && tries < 3; tries++) {
    await sleep(deps.sentCopyWaitMs ?? 1500);
    found = await find();
  }
  if (found.uids.length === 0) {
    await client.append(path, raw, ['\\Seen']);
    found = await find();
  }
  if (found.uids.length === 0) {
    logger.warn({ folder: path }, 'sent copy not found after adding it');
    return;
  }
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    await fetchAndEnqueue(client, found.uids, {
      account: { id: envelope.accountId!, userId: envelope.userId },
      folder: { path, role: 'sent' },
      uidValidity: found.uidValidity,
      byUid: true,
      backfill: false,
      producer: deps.ingest,
      logger,
    });
  } finally {
    lock.release();
  }
}

export function createSendHandler(deps: SendDeps) {
  return async (envelope: JobEnvelope<SendPayload>, { logger, attempt }: JobContext) => {
    const { accountId, userId, payload } = envelope;
    if (!accountId) throw new ValidationError('Send job is missing accountId');
    const account = { id: accountId, userId };
    const report = (status: 'sent' | 'failed', error: string | null = null) =>
      deps.changes.enqueue(
        changeEnvelope(account, { type: 'sendResult', outboxId: payload.outboxId, status, error }),
      );
    const acceptedKey = `send:accepted:${payload.outboxId}`;
    let accepted = (await deps.accepted.get(acceptedKey)) !== null;

    try {
      const sender = await deps.internal.getCredentials(accountId);
      if (sender.userId !== userId) throw new SendRefused('That account is not yours');
      const raw = await rawMessage(payload, sender, deps.blobs);
      if (!accepted) {
        await smtpSend(raw, payload, sender, deps);
        await deps.accepted.set(acceptedKey, '1', 'EX', ACCEPTED_TTL_S);
        accepted = true;
        logger.info({ outboxId: payload.outboxId }, 'message accepted for delivery');
      }

      let client: ImapFlow | undefined;
      try {
        client = await openImapClient(accountId, { ...deps, idle: 'off' });
        await fileSentCopy(client, raw, envelope, deps, logger);
      } finally {
        if (client?.usable) await client.logout().catch(() => client?.close());
      }
      await report('sent');
    } catch (err) {
      if (err instanceof SendRefused) {
        await report('failed', err.message);
        return;
      }
      if (attempt >= deps.maxAttempts) {
        // Delivered, but the Sent copy couldn't be filed: still sent; sync brings it in later.
        if (accepted) await report('sent');
        else await report('failed', "Couldn't reach the mail server. Try sending again.");
      }
      if (err instanceof AuthenticationFailedError && accepted) {
        await report('sent');
        return;
      }
      throw err;
    }
  };
}
