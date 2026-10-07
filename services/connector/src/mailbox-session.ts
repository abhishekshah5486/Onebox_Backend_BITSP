import type { IngestPayload } from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import type { MailboxStore } from '@onebox/mailbox-state';
import type { Producer } from '@onebox/queue';
import type { ImapFlow } from 'imapflow';
import { FOLDER, openImapClient } from './imap-client';
import { fetchAndEnqueue } from './ingest-jobs';
import type { ActiveAccount, InternalClient } from './internal-client';
import { planSync, readFolderState } from './sync-plan';

export { AuthenticationFailedError } from './imap-client';

const FETCH_BATCH = 50;

export interface SessionDeps {
  internal: InternalClient;
  producer: Producer<IngestPayload>;
  store: MailboxStore;
  logger: Logger;
  allowPrivateHosts: boolean;
  // How many of the newest messages the first sync fetches; older mail loads on demand.
  initialBatch: number;
  highWatermark: number;
  connectTimeoutMs?: number;
  // Safety net for servers that silently stop sending IDLE notifications.
  pollIntervalMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function debounce(fn: () => void, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
  run.cancel = () => clearTimeout(timer);
  return run;
}

// Runs one IMAP connection for an account until it closes, the signal aborts, or it fails.
export async function runMailboxSession(
  account: ActiveAccount,
  deps: SessionDeps,
  signal: AbortSignal,
) {
  const { internal, producer, store, initialBatch, highWatermark } = deps;
  const logger = deps.logger.child({ accountId: account.id });
  const client: ImapFlow = await openImapClient(account.id, deps);
  client.on('error', (err: Error) => logger.warn({ err: err.message }, 'imap connection error'));

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
    const fetchOptions = (backfill: boolean, byUid: boolean) => ({
      account,
      uidValidity,
      byUid,
      backfill,
      producer,
      logger,
    });

    const publishCounts = async () => {
      if (!client.usable) return;
      const status = await client.status(FOLDER, { messages: true, unseen: true });
      if (!status) return;
      await store.setCounts({
        userId: account.userId,
        accountId: account.id,
        folder: FOLDER,
        uidValidity,
        total: status.messages ?? 0,
        unread: status.unseen ?? 0,
        updatedAt: new Date().toISOString(),
      });
    };
    const refreshCounts = debounce(() => {
      publishCounts().catch((err: unknown) =>
        logger.warn({ err }, 'could not refresh mailbox counts'),
      );
    }, 2000);

    const waitForCapacity = async () => {
      while (!signal.aborted && (await producer.pending()) > highWatermark) {
        logger.debug('ingest queue is full, pausing fetch');
        await sleep(1000);
      }
    };

    const fetchUids = async (uids: number[], backfill: boolean) => {
      for (let i = 0; i < uids.length && !signal.aborted; i += FETCH_BATCH) {
        await waitForCapacity();
        const batch = uids.slice(i, i + FETCH_BATCH);
        await withLock(() => fetchAndEnqueue(client, batch, fetchOptions(backfill, true)));
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
      // Only the newest page is fetched up front; the user pages back through history on demand.
      const first = Math.max(1, exists - initialBatch + 1);
      if (exists > 0) {
        await withLock(() =>
          fetchAndEnqueue(client, `${first}:${exists}`, fetchOptions(true, false)),
        );
      }
      lastUid = uidNext - 1;
      await internal.saveSyncState(account.id, FOLDER, { uidValidity, lastUid });
      await store.setHistory(account.id, FOLDER, exists > initialBatch ? 'idle' : 'complete');
      logger.info(
        { fetched: Math.min(exists, initialBatch), total: exists, reason: plan.reason },
        'initial sync finished',
      );
    } else {
      lastUid = plan.fromUid - 1;
    }
    await publishCounts();

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
          refreshCounts();
        })
        .catch((err: unknown) => logger.error({ err }, 'fetching new mail failed'));
    };

    client.on('exists', fetchNew);
    // Deletions and read/unread changes made elsewhere change the server counts.
    client.on('expunge', refreshCounts);
    client.on('flags', refreshCounts);
    const poll = setInterval(
      () => {
        fetchNew();
        refreshCounts();
      },
      deps.pollIntervalMs ?? 5 * 60_000,
    );
    fetchNew();
    await closed;
    clearInterval(poll);
    refreshCounts.cancel();
    await pending;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (client.usable) await client.logout().catch(() => client.close());
    logger.info('mailbox session ended');
  }
}
