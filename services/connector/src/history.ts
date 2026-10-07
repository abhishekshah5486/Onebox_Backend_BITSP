import type { HistoryPayload, IngestPayload, JobEnvelope } from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import type { MailboxStore } from '@onebox/mailbox-state';
import type { JobContext, Producer } from '@onebox/queue';
import type { ImapFlow } from 'imapflow';
import { AuthenticationFailedError, openImapClient } from './imap-client';
import { fetchAndEnqueue } from './ingest-jobs';
import type { InternalClient } from './internal-client';

export interface HistoryDeps {
  internal: InternalClient;
  store: MailboxStore;
  producer: Producer<IngestPayload>;
  allowPrivateHosts: boolean;
  connectTimeoutMs?: number;
  ingestTimeoutMs?: number;
}

// Fetches one older page on a short-lived second connection, so the live IDLE session is untouched.
export function createHistoryHandler(deps: HistoryDeps) {
  const { store, producer } = deps;

  return async (envelope: JobEnvelope<HistoryPayload>, { logger }: JobContext) => {
    const { accountId, userId, payload } = envelope;
    if (!accountId) throw new ValidationError('History job is missing accountId');
    const { folder, role, uidValidity, beforeUid, count } = payload;

    if (beforeUid <= 1) {
      await store.setHistory(accountId, role, 'complete');
      return;
    }
    await store.setHistory(accountId, role, 'fetching');

    let client: ImapFlow | undefined;
    try {
      client = await openImapClient(accountId, { ...deps, idle: 'off' });
      const lock = await client.getMailboxLock(folder);
      let jobIds: string[] = [];
      let remaining = 0;
      try {
        if (Number(client.mailbox && client.mailbox.uidValidity) !== uidValidity) {
          await store.setHistory(
            accountId,
            role,
            'error',
            'The mailbox was reorganised on the server and is being re-synced.',
          );
          logger.warn({ accountId, folder }, 'uidvalidity changed, skipping history fetch');
          return;
        }
        const older = (
          (await client.search({ uid: `1:${beforeUid - 1}` }, { uid: true })) || []
        ).sort((a, b) => a - b);
        const batch = older.slice(-count);
        remaining = older.length - batch.length;
        if (batch.length > 0) {
          ({ jobIds } = await fetchAndEnqueue(client, batch, {
            account: { id: accountId, userId },
            folder: { path: folder, role },
            uidValidity,
            byUid: true,
            backfill: true,
            producer,
            logger,
          }));
        }
      } finally {
        lock.release();
      }

      // Only report done once the mail is actually stored, so the next page is ready to show.
      await producer.waitUntilProcessed(jobIds, { timeoutMs: deps.ingestTimeoutMs ?? 120_000 });
      await store.setHistory(accountId, role, remaining > 0 ? 'idle' : 'complete');
      logger.info({ accountId, role, fetched: jobIds.length, remaining }, 'older mail fetched');
    } catch (err) {
      if (err instanceof AuthenticationFailedError) {
        await store.setHistory(
          accountId,
          role,
          'error',
          'The mail server rejected the stored password. Reconnect the account in Settings.',
        );
        throw new ValidationError('Mailbox credentials rejected', { cause: err });
      }
      await store.setHistory(accountId, role, 'error', 'Could not fetch older mail. Try again.');
      throw err;
    } finally {
      if (client?.usable) await client.logout().catch(() => client?.close());
    }
  };
}
