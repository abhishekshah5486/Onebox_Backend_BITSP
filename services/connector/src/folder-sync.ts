import type { IngestPayload } from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import type { MailboxStore } from '@onebox/mailbox-state';
import type { Producer } from '@onebox/queue';
import type { ImapFlow } from 'imapflow';
import { discoverFolders } from './folders';
import { openImapClient } from './imap-client';
import { fetchAndEnqueue, type FolderRef } from './ingest-jobs';
import type { ActiveAccount, InternalClient } from './internal-client';
import { planSync, readFolderState, type FolderState } from './sync-plan';

const FETCH_BATCH = 50;

export interface FolderSyncDeps {
  internal: InternalClient;
  producer: Producer<IngestPayload>;
  store: MailboxStore;
  logger: Logger;
  allowPrivateHosts: boolean;
  initialBatch: number;
  connectTimeoutMs?: number;
  waitForCapacity: () => Promise<void>;
}

async function syncFolder(
  client: ImapFlow,
  account: ActiveAccount,
  folder: FolderRef,
  cursors: Map<string, FolderState>,
  deps: FolderSyncDeps,
  signal: AbortSignal,
) {
  const { internal, producer, store, logger, initialBatch } = deps;
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  let uidValidity = 0;
  let fetched = 0;
  try {
    const mailbox = client.mailbox;
    if (!mailbox) throw new Error(`${folder.path} could not be opened`);
    uidValidity = Number(mailbox.uidValidity);
    const options = (backfill: boolean, byUid: boolean) => ({
      account,
      folder,
      uidValidity,
      byUid,
      backfill,
      producer,
      logger,
    });
    const plan = planSync(cursors.get(folder.path) ?? null, uidValidity);

    if (plan.kind === 'backfill') {
      const exists = mailbox.exists;
      if (exists > 0) {
        const first = Math.max(1, exists - initialBatch + 1);
        fetched = (await fetchAndEnqueue(client, `${first}:${exists}`, options(true, false))).uids
          .length;
      }
      const state = { uidValidity, lastUid: Number(mailbox.uidNext) - 1 };
      cursors.set(folder.path, state);
      await internal.saveSyncState(account.id, folder.path, state);
      await store.setHistory(account.id, folder.role, exists > initialBatch ? 'idle' : 'complete');
    } else {
      const lastUid = plan.fromUid - 1;
      const found = (await client.search({ uid: `${plan.fromUid}:*` }, { uid: true })) || [];
      const uids = found.filter((uid) => uid > lastUid).sort((a, b) => a - b);
      for (let i = 0; i < uids.length && !signal.aborted; i += FETCH_BATCH) {
        await deps.waitForCapacity();
        const batch = uids.slice(i, i + FETCH_BATCH);
        await fetchAndEnqueue(client, batch, options(false, true));
        fetched += batch.length;
        const state = { uidValidity, lastUid: Math.max(...batch) };
        cursors.set(folder.path, state);
        await internal.saveSyncState(account.id, folder.path, state);
      }
    }
  } finally {
    lock.release();
  }

  const status = await client.status(folder.path, { messages: true, unseen: true });
  if (status) {
    await store.setCounts({
      userId: account.userId,
      accountId: account.id,
      role: folder.role,
      folder: folder.path,
      uidValidity,
      total: status.messages ?? 0,
      unread: status.unseen ?? 0,
      updatedAt: new Date().toISOString(),
    });
  }
  if (fetched > 0) logger.info({ role: folder.role, fetched }, 'folder synced');
}

// Sent, drafts, spam and trash are polled on a short-lived connection so the inbox keeps its IDLE.
export function createFolderSync(account: ActiveAccount, deps: FolderSyncDeps) {
  const cursors = new Map<string, FolderState>();
  for (const [path, value] of Object.entries(account.syncState)) {
    const state = readFolderState(value);
    if (state) cursors.set(path, state);
  }

  return async (signal: AbortSignal) => {
    const client = await openImapClient(account.id, { ...deps, idle: 'off' });
    client.on('error', (err: Error) =>
      deps.logger.debug({ err: err.message }, 'folder sync connection error'),
    );
    try {
      const folders = discoverFolders(await client.list());
      for (const folder of folders) {
        if (signal.aborted) break;
        try {
          await syncFolder(client, account, folder, cursors, deps, signal);
        } catch (err) {
          deps.logger.warn(
            { role: folder.role, err: (err as Error).message },
            'folder sync failed',
          );
          if (!client.usable) throw err;
        }
      }
      return folders;
    } finally {
      if (client.usable) await client.logout().catch(() => client.close());
    }
  };
}
