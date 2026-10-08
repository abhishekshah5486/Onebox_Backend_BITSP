import type {
  JobEnvelope,
  MailboxChangePayload,
  MailboxOpPayload,
  MailboxTarget,
} from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import type { JobContext, Producer } from '@onebox/queue';
import type { ImapFlow, ListResponse } from 'imapflow';
import { changeEnvelope } from './folder-sync';
import { discoverFolders } from './folders';
import { AuthenticationFailedError, openImapClient } from './imap-client';
import type { InternalClient } from './internal-client';

export interface OpsDeps {
  internal: InternalClient;
  changes: Producer<MailboxChangePayload>;
  allowPrivateHosts: boolean;
  connectTimeoutMs?: number;
  // After this many attempts the op is given up and the server state wins again.
  maxAttempts: number;
}

// Providers without an archive folder (plain IMAP) get one, like most mail apps create.
const ARCHIVE_FALLBACK = 'Archive';

async function resolveTarget(client: ImapFlow, entries: ListResponse[], target: MailboxTarget) {
  if ('label' in target) {
    if (!entries.some((entry) => entry.path === target.label)) {
      throw new ValidationError(`Label ${target.label} no longer exists`);
    }
    return { path: target.label, role: 'label' as const };
  }
  if (target.role === 'inbox') return { path: 'INBOX', role: 'inbox' as const };
  const found = discoverFolders(entries).folders.find((folder) => folder.role === target.role);
  if (found) return { path: found.path, role: target.role };
  if (target.role !== 'archive') throw new ValidationError(`This mailbox has no ${target.role}`);
  await client.mailboxCreate(ARCHIVE_FALLBACK);
  return { path: ARCHIVE_FALLBACK, role: 'archive' as const };
}

export function createOpsHandler(deps: OpsDeps) {
  return async (envelope: JobEnvelope<MailboxOpPayload>, { logger, attempt }: JobContext) => {
    const { accountId, userId, payload } = envelope;
    if (!accountId) throw new ValidationError('Mailbox op is missing accountId');
    const account = { id: accountId, userId };
    const { folder, uidValidity, uids, op } = payload;
    const emit = (change: MailboxChangePayload) =>
      deps.changes.enqueue(changeEnvelope(account, change));
    const settle = () => emit({ type: 'settled', folder, uidValidity, uids });

    let client: ImapFlow | undefined;
    try {
      client = await openImapClient(accountId, { ...deps, idle: 'off' });
      const entries = op.type === 'move' ? await client.list() : [];
      const target = op.type === 'move' ? await resolveTarget(client, entries, op.to) : null;
      // Gmail's All Mail holds every message; "moving" out of it only adds a label, so it is a copy.
      const copy = entries.some((entry) => entry.path === folder && entry.specialUse === '\\All');

      const lock = await client.getMailboxLock(folder);
      try {
        if (Number(client.mailbox && client.mailbox.uidValidity) !== uidValidity) {
          logger.warn({ folder }, 'folder was renumbered, dropping mailbox op');
          await settle();
          return;
        }
        const set = uids.join(',');

        if (op.type === 'flags') {
          if (op.add.length) await client.messageFlagsAdd(set, op.add, { uid: true });
          if (op.remove.length) await client.messageFlagsRemove(set, op.remove, { uid: true });
          await settle();
        } else if (op.type === 'expunge') {
          await client.messageDelete(set, { uid: true });
          await emit({ type: 'removed', folder, uidValidity, uids });
        } else if (target) {
          const result = copy
            ? await client.messageCopy(set, target.path, { uid: true })
            : await client.messageMove(set, target.path, { uid: true });
          const uidMap = result && result.uidMap ? [...result.uidMap] : [];
          if (uidMap.length > 0 && result && result.uidValidity !== undefined) {
            await emit({
              type: 'moved',
              folder,
              uidValidity,
              to: {
                folder: target.path,
                role: target.role,
                uidValidity: Number(result.uidValidity),
              },
              uidMap,
              keepSource: copy,
            });
          }
          // Without UIDPLUS the new copies are picked up by the next sync of the destination.
          const mapped = new Set(uidMap.map(([from]) => from));
          const rest = uids.filter((uid) => !mapped.has(uid) || copy);
          if (rest.length > 0) {
            await emit(
              copy
                ? { type: 'settled', folder, uidValidity, uids: rest }
                : { type: 'removed', folder, uidValidity, uids: rest },
            );
          }
        }
      } finally {
        lock.release();
      }
      logger.info({ accountId, op: op.type, folder, count: uids.length }, 'mailbox op applied');
    } catch (err) {
      const final =
        err instanceof AuthenticationFailedError ||
        err instanceof ValidationError ||
        attempt >= deps.maxAttempts;
      if (final) await settle().catch(() => {});
      if (err instanceof AuthenticationFailedError) {
        throw new ValidationError('Mailbox credentials rejected', { cause: err });
      }
      throw err;
    } finally {
      if (client?.usable) await client.logout().catch(() => client?.close());
    }
  };
}
