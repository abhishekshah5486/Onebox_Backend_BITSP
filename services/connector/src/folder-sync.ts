import { randomUUID } from 'node:crypto';
import {
  createJobEnvelope,
  encodeUidSet,
  type MailCategory,
  type IngestPayload,
  type MailboxChangePayload,
  mailboxKey,
} from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import type { MailboxStore } from '@onebox/mailbox-state';
import type { Producer } from '@onebox/queue';
import type { ImapFlow } from 'imapflow';
import { discoverFolders } from './folders';
import { hasCategories, readCategories } from './gmail';
import { FOLDER, openImapClient } from './imap-client';
import { fetchAndEnqueue, type FolderRef } from './ingest-jobs';
import type { ActiveAccount, InternalClient } from './internal-client';
import { planSync, readFolderState, type FolderState } from './sync-plan';

const FETCH_BATCH = 50;
// Without CONDSTORE, flag changes made elsewhere are picked up for this many newest messages.
const FLAG_WINDOW = 200;

export interface FolderSyncDeps {
  internal: InternalClient;
  producer: Producer<IngestPayload>;
  changes: Producer<MailboxChangePayload>;
  store: MailboxStore;
  logger: Logger;
  allowPrivateHosts: boolean;
  initialBatch: number;
  connectTimeoutMs?: number;
  waitForCapacity: () => Promise<void>;
}

export function changeEnvelope(
  account: Pick<ActiveAccount, 'id' | 'userId'>,
  payload: MailboxChangePayload,
) {
  return createJobEnvelope({
    jobId: randomUUID(),
    userId: account.userId,
    accountId: account.id,
    payload,
  });
}

// Everything in the folder right now, plus flag changes since the last look. Caller holds the lock.
async function snapshot(
  client: ImapFlow,
  account: ActiveAccount,
  folder: FolderRef,
  modseqs: Map<string, bigint>,
  changes: Producer<MailboxChangePayload>,
) {
  const mailbox = client.mailbox;
  if (!mailbox) return;
  const present = ((await client.search({ all: true }, { uid: true })) || []).sort((a, b) => a - b);
  const since = modseqs.get(folder.path);
  const highest = mailbox.highestModseq;
  const flags: { uid: number; flags: string[] }[] = [];
  if (!since || !highest || highest > since) {
    const range = since && highest ? '1:*' : present.slice(-FLAG_WINDOW).join(',');
    if (range) {
      for await (const message of client.fetch(
        range,
        { uid: true, flags: true },
        { uid: true, ...(since && highest && { changedSince: since }) },
      )) {
        flags.push({ uid: message.uid, flags: [...(message.flags ?? [])] });
      }
    }
  }
  if (highest) modseqs.set(folder.path, highest);

  let categories: Partial<Record<MailCategory, string>> | undefined;
  if (hasCategories(client, folder.role)) {
    const byUid = await readCategories(client, { all: true });
    const grouped: Partial<Record<MailCategory, number[]>> = {};
    for (const [uid, tags] of byUid) for (const tag of tags) (grouped[tag] ??= []).push(uid);
    categories = Object.fromEntries(
      Object.entries(grouped).map(([tab, uids]) => [tab, encodeUidSet(uids)]),
    );
  }

  await changes.enqueue(
    changeEnvelope(account, {
      type: 'snapshot',
      folder: folder.path,
      role: folder.role,
      uidValidity: Number(mailbox.uidValidity),
      uidNext: Math.max(1, mailbox.uidNext),
      present: encodeUidSet(present),
      flags,
      ...(categories && { categories }),
    }),
  );
}

async function syncFolder(
  client: ImapFlow,
  account: ActiveAccount,
  folder: FolderRef,
  state: { cursors: Map<string, FolderState>; modseqs: Map<string, bigint> },
  deps: FolderSyncDeps,
  signal: AbortSignal,
) {
  const { internal, producer, store, logger, initialBatch } = deps;
  const { cursors } = state;
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

    // The live session fetches the inbox; here it only gets a snapshot.
    if (folder.role !== 'inbox') {
      const plan = planSync(cursors.get(folder.path) ?? null, uidValidity);
      if (plan.kind === 'backfill') {
        const exists = mailbox.exists;
        if (exists > 0) {
          const first = Math.max(1, exists - initialBatch + 1);
          fetched = (await fetchAndEnqueue(client, `${first}:${exists}`, options(true, false))).uids
            .length;
        }
        const next = { uidValidity, lastUid: Number(mailbox.uidNext) - 1 };
        cursors.set(folder.path, next);
        await internal.saveSyncState(account.id, folder.path, next);
        await store.setHistory(
          account.id,
          mailboxKey(folder.role, folder.path),
          exists > initialBatch ? 'idle' : 'complete',
        );
      } else {
        const lastUid = plan.fromUid - 1;
        const found = (await client.search({ uid: `${plan.fromUid}:*` }, { uid: true })) || [];
        const uids = found.filter((uid) => uid > lastUid).sort((a, b) => a - b);
        for (let i = 0; i < uids.length && !signal.aborted; i += FETCH_BATCH) {
          await deps.waitForCapacity();
          const batch = uids.slice(i, i + FETCH_BATCH);
          await fetchAndEnqueue(client, batch, options(false, true));
          fetched += batch.length;
          const next = { uidValidity, lastUid: Math.max(...batch) };
          cursors.set(folder.path, next);
          await internal.saveSyncState(account.id, folder.path, next);
        }
      }
    }
    if (!signal.aborted) await snapshot(client, account, folder, state.modseqs, deps.changes);
  } finally {
    lock.release();
  }

  const status = await client.status(folder.path, { messages: true, unseen: true });
  if (status && folder.role !== 'inbox') {
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

// Every folder but the inbox is polled on a short-lived connection so the inbox keeps its IDLE.
// Each pass also snapshots every folder (inbox included) so moves and deletions made elsewhere,
// and read or starred changes, reach OneBox.
export function createFolderSync(account: ActiveAccount, deps: FolderSyncDeps) {
  const cursors = new Map<string, FolderState>();
  const modseqs = new Map<string, bigint>();
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
      const { folders, labels } = discoverFolders(await client.list());
      await deps.store.setLabels(
        account.id,
        labels.map(({ path, name }) => ({ path, name })),
      );
      for (const folder of [{ path: FOLDER, role: 'inbox' as const }, ...folders, ...labels]) {
        if (signal.aborted) break;
        try {
          await syncFolder(client, account, folder, { cursors, modseqs }, deps, signal);
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
