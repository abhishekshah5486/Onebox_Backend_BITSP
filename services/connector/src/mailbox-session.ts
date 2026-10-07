import {
  createJobEnvelope,
  ingestDedupeKey,
  MAX_RAW_MESSAGE_BYTES,
  type IngestPayload,
} from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import { resolvePublicHost } from '@onebox/net-guard';
import type { Producer } from '@onebox/queue';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import type { ActiveAccount, InternalClient } from './internal-client';
import { planSync, readFolderState } from './sync-plan';

export const FOLDER = 'INBOX';
const FETCH_BATCH = 50;

export class AuthenticationFailedError extends Error {
  constructor(readonly serverResponse: string | undefined) {
    super('Mailbox rejected the stored credentials');
    this.name = 'AuthenticationFailedError';
  }
}

export interface SessionDeps {
  internal: InternalClient;
  producer: Producer<IngestPayload>;
  logger: Logger;
  allowPrivateHosts: boolean;
  backfillDays: number;
  highWatermark: number;
  connectTimeoutMs?: number;
  // Safety net for servers that silently stop sending IDLE notifications.
  pollIntervalMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs one IMAP connection for an account until it closes, the signal aborts, or it fails.
export async function runMailboxSession(
  account: ActiveAccount,
  deps: SessionDeps,
  signal: AbortSignal,
) {
  const { internal, producer, allowPrivateHosts, backfillDays, highWatermark } = deps;
  const logger = deps.logger.child({ accountId: account.id });
  const credentials = await internal.getCredentials(account.id);
  const resolved = await resolvePublicHost(credentials.host, { allowPrivate: allowPrivateHosts });
  const timeoutMs = deps.connectTimeoutMs ?? 30_000;

  const client = new ImapFlow({
    host: resolved.address,
    port: credentials.port,
    secure: credentials.tls,
    servername: credentials.host,
    tls: { servername: credentials.host, rejectUnauthorized: true },
    auth: { user: credentials.username, pass: credentials.password },
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
  });
  client.on('error', (err: Error) => logger.warn({ err: err.message }, 'imap connection error'));

  try {
    await client.connect();
  } catch (err) {
    const error = err as { authenticationFailed?: boolean; responseText?: string };
    if (error.authenticationFailed) throw new AuthenticationFailedError(error.responseText);
    throw err;
  }

  const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
  const onAbort = () => void client.logout().catch(() => client.close());
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    // The mailbox lock is held only while working: imapflow IDLEs only when no lock is held.
    const withLock = async <T>(work: () => Promise<T>) => {
      const lock = await client.getMailboxLock(FOLDER);
      try {
        return await work();
      } finally {
        lock.release();
      }
    };

    let uidValidity = 0;
    let lastUid = 0;

    const waitForCapacity = async () => {
      while (!signal.aborted && (await producer.pending()) > highWatermark) {
        logger.debug('ingest queue is full, pausing fetch');
        await sleep(1000);
      }
    };

    const enqueue = async (message: FetchMessageObject, backfill: boolean) => {
      if (!message.source || message.source.length > MAX_RAW_MESSAGE_BYTES) {
        logger.warn(
          { uid: message.uid, sizeBytes: message.size },
          'skipping message that is too large',
        );
        return;
      }
      const payload: IngestPayload = {
        folder: FOLDER,
        uid: message.uid,
        uidValidity,
        flags: [...(message.flags ?? [])],
        internalDate: message.internalDate ? new Date(message.internalDate).toISOString() : null,
        sizeBytes: message.size ?? message.source.length,
        backfill,
        rawSource: message.source.toString('base64'),
      };
      await producer.enqueue(
        createJobEnvelope({
          jobId: ingestDedupeKey({
            accountId: account.id,
            folder: FOLDER,
            uidValidity,
            uid: message.uid,
          }),
          userId: account.userId,
          accountId: account.id,
          payload,
        }),
      );
    };

    const fetchUids = async (uids: number[], backfill: boolean) => {
      for (let i = 0; i < uids.length && !signal.aborted; i += FETCH_BATCH) {
        await waitForCapacity();
        const batch = uids.slice(i, i + FETCH_BATCH);
        // BODY.PEEK keeps the fetch itself from marking anything as read.
        await withLock(async () => {
          for await (const message of client.fetch(
            batch,
            { uid: true, flags: true, internalDate: true, size: true, source: true },
            { uid: true },
          )) {
            await enqueue(message, backfill);
          }
        });
        lastUid = Math.max(lastUid, ...batch);
        await internal.saveSyncState(account.id, FOLDER, { uidValidity, lastUid });
      }
    };

    const { plan, uidNext, exists } = await withLock(async () => {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error(`${FOLDER} could not be opened`);
      uidValidity = Number(mailbox.uidValidity);
      return {
        plan: planSync(readFolderState(account.syncState[FOLDER]), uidValidity),
        uidNext: Number(mailbox.uidNext),
        exists: mailbox.exists,
      };
    });
    await internal.reportStatus(account.id, 'CONNECTED', null);
    logger.info({ folder: FOLDER, plan: plan.kind, messages: exists }, 'mailbox session started');

    if (plan.kind === 'backfill') {
      const since = new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000);
      const uids = ((await withLock(() => client.search({ since }, { uid: true }))) || []).sort(
        (a, b) => a - b,
      );
      logger.info(
        { count: uids.length, since: since.toISOString(), reason: plan.reason },
        'backfill started',
      );
      await fetchUids(uids, true);
      lastUid = Math.max(lastUid, uidNext - 1);
      await internal.saveSyncState(account.id, FOLDER, { uidValidity, lastUid });
      logger.info({ count: uids.length, lastUid }, 'backfill finished');
    } else {
      lastUid = plan.fromUid - 1;
    }

    // Fetches everything newer than the cursor; serialised so bursts of EXISTS cannot overlap.
    let pending = Promise.resolve();
    const fetchNew = () => {
      pending = pending
        .then(async () => {
          if (signal.aborted || !client.usable) return;
          const found =
            (await withLock(() => client.search({ uid: `${lastUid + 1}:*` }, { uid: true }))) || [];
          const uids = found.filter((uid) => uid > lastUid).sort((a, b) => a - b);
          if (uids.length === 0) return;
          await fetchUids(uids, false);
          logger.info({ count: uids.length, lastUid }, 'new mail fetched');

          const { markSeenOnFetch } = await internal.getPreferences(account.userId);
          if (markSeenOnFetch) {
            await withLock(() => client.messageFlagsAdd(uids, ['\\Seen'], { uid: true }));
          }
        })
        .catch((err: unknown) => logger.error({ err }, 'fetching new mail failed'));
    };

    client.on('exists', fetchNew);
    const poll = setInterval(fetchNew, deps.pollIntervalMs ?? 5 * 60_000);
    fetchNew();
    await closed;
    clearInterval(poll);
    await pending;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (client.usable) await client.logout().catch(() => client.close());
    logger.info('mailbox session ended');
  }
}
