import { randomUUID } from 'node:crypto';
import { createMemoryBlobStore } from '@onebox/blob-store';
import {
  createJobEnvelope,
  type IngestPayload,
  type JobEnvelope,
  type MailboxChangePayload,
  type SendPayload,
} from '@onebox/contracts';
import { createLogger } from '@onebox/logger';
import type { Producer } from '@onebox/queue';
import { startGreenMail, type TestMailServer } from '@onebox/testing';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InternalClient } from './internal-client';
import { createSendHandler } from './send';

const logger = createLogger({ service: 'test', level: 'silent' });
const me = { email: 'me@onebox.test', password: 'secret-pass' };
const priya = { email: 'priya@acme.test', password: 'priya-pass' };
const sam = { email: 'sam@acme.test', password: 'sam-pass' };
const boss = { email: 'boss@acme.test', password: 'boss-pass' };

let mail: TestMailServer;
const blobs = createMemoryBlobStore();
const accepted = new Map<string, string>();
const results: MailboxChangePayload[] = [];
const ingested: JobEnvelope<IngestPayload>[] = [];

beforeAll(async () => {
  mail = await startGreenMail([me, priya, sam, boss]);
}, 120_000);

afterAll(async () => {
  await mail.stop();
});

const internal = (password = me.password, userId = 'user-1'): InternalClient =>
  ({
    getCredentials: async () => ({
      host: mail.host,
      port: mail.imapPort,
      tls: false,
      username: me.email,
      password,
      userId,
      emailAddress: me.email,
      displayName: 'Me Myself',
      smtp: { host: mail.host, port: mail.smtpPort, tls: false },
    }),
  }) as unknown as InternalClient;

const handler = (client = internal()) =>
  createSendHandler({
    internal: client,
    changes: {
      enqueue: async (envelope) => {
        results.push(envelope.payload);
        return { jobId: envelope.jobId, duplicate: false };
      },
    },
    ingest: {
      enqueue: async (envelope: JobEnvelope<IngestPayload>) => {
        ingested.push(envelope);
        return { jobId: envelope.jobId, duplicate: false };
      },
    } as unknown as Producer<IngestPayload>,
    blobs,
    accepted: {
      get: async (key) => accepted.get(key) ?? null,
      set: async (key, value) => accepted.set(key, value),
    },
    allowPrivateHosts: true,
    requireStartTls: false,
    maxAttempts: 3,
    sentCopyWaitMs: 50,
  });

const job = (overrides: Partial<SendPayload> = {}) => {
  const outboxId = randomUUID();
  return createJobEnvelope<SendPayload>({
    jobId: `send-${outboxId}`,
    userId: 'user-1',
    accountId: 'acc-1',
    payload: {
      outboxId,
      messageId: `<${outboxId}@onebox.test>`,
      to: [{ name: 'Priya', address: priya.email }],
      cc: [{ name: null, address: sam.email }],
      bcc: [{ name: null, address: boss.email }],
      subject: `Pricing ${outboxId.slice(0, 8)}`,
      html: '<p>Hi <b>Priya</b></p>',
      text: 'Hi Priya',
      inReplyTo: null,
      references: [],
      attachments: [],
      ...overrides,
    },
  });
};
const context = (attempt = 1) => ({ logger, attempt });

async function inbox(user: { email: string; password: string }, folder = 'INBOX') {
  const client = new ImapFlow({
    host: mail.host,
    port: mail.imapPort,
    secure: false,
    auth: { user: user.email, pass: user.password },
    logger: false,
  });
  await client.connect();
  const messages: { subject: string; source: string }[] = [];
  if ((await client.list()).some((entry) => entry.path === folder)) {
    const lock = await client.getMailboxLock(folder);
    try {
      if ((client.mailbox && client.mailbox.exists) || 0) {
        for await (const message of client.fetch('1:*', { envelope: true, source: true })) {
          messages.push({
            subject: message.envelope?.subject ?? '',
            source: message.source?.toString() ?? '',
          });
        }
      }
    } finally {
      lock.release();
    }
  }
  await client.logout();
  return messages;
}

describe('sending', () => {
  it('delivers to every recipient, hides Bcc, and files and stores the Sent copy', async () => {
    await blobs.put('uploads/quote.txt', Buffer.from('Quote: 20 seats'), 'text/plain');
    const envelope = job({
      attachments: [
        {
          blobKey: 'uploads/quote.txt',
          filename: 'quote.txt',
          contentType: 'text/plain',
          sizeBytes: 15,
        },
      ],
    });
    await handler()(envelope, context());

    for (const user of [priya, sam, boss]) {
      const got = (await inbox(user)).filter((m) => m.subject === envelope.payload.subject);
      expect(got).toHaveLength(1);
      expect(got[0]!.source).toContain('From: Me Myself <me@onebox.test>');
      expect(got[0]!.source).not.toMatch(/^Bcc:/im);
      expect(got[0]!.source).toContain('filename=quote.txt');
    }

    const sent = (await inbox(me, 'Sent')).filter((m) => m.subject === envelope.payload.subject);
    expect(sent).toHaveLength(1);
    const stored = ingested.filter((e) => e.payload.folder === 'Sent');
    expect(stored.at(-1)!.payload).toMatchObject({ role: 'sent', backfill: false });
    expect(results.at(-1)).toEqual({
      type: 'sendResult',
      outboxId: envelope.payload.outboxId,
      status: 'sent',
      error: null,
    });
  });

  it('never sends twice when a job is retried after the server accepted it', async () => {
    const envelope = job();
    await handler()(envelope, context());
    await handler()(envelope, context(2));
    expect((await inbox(priya)).filter((m) => m.subject === envelope.payload.subject)).toHaveLength(
      1,
    );
    expect(
      (await inbox(me, 'Sent')).filter((m) => m.subject === envelope.payload.subject),
    ).toHaveLength(1);
  });

  it("refuses to send from someone else's account, or with a rejected password", async () => {
    const foreign = job();
    await handler(internal(me.password, 'someone-else'))(foreign, context());
    expect(results.at(-1)).toMatchObject({ status: 'failed', error: 'That account is not yours' });

    const badLogin = job();
    await handler(internal('wrong-pass'))(badLogin, context());
    expect(results.at(-1)).toMatchObject({ outboxId: badLogin.payload.outboxId, status: 'failed' });
    expect((results.at(-1) as { error: string }).error).toMatch(/password/);
    expect((await inbox(priya)).some((m) => m.subject === badLogin.payload.subject)).toBe(false);
  });
});
