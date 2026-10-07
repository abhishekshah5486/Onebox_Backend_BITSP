import { isAppError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Redis } from 'ioredis';
import type { ActiveAccount, InternalClient } from './internal-client';
import { createLease, type Lease } from './lease';
import { AuthenticationFailedError, runMailboxSession, type SessionDeps } from './mailbox-session';

export interface SupervisorDeps {
  internal: InternalClient;
  redis: Redis;
  logger: Logger;
  ownerId: string;
  sessionDeps: Omit<SessionDeps, 'internal' | 'logger'>;
  reconcileIntervalMs: number;
  leaseTtlMs?: number;
  runSession?: typeof runMailboxSession;
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

const UNREACHABLE_AFTER_FAILURES = 3;

export function backoffMs(failures: number, random = Math.random) {
  const base = Math.min(300_000, 1000 * 2 ** failures);
  return Math.round(base * (0.5 + random() * 0.5));
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

export function createSupervisor({
  internal,
  redis,
  logger,
  ownerId,
  sessionDeps,
  reconcileIntervalMs,
  leaseTtlMs = 30_000,
  runSession = runMailboxSession,
}: SupervisorDeps) {
  const running = new Map<string, Running>();
  let timer: NodeJS.Timeout | undefined;
  let reconciling: Promise<void> | undefined;

  async function supervise(accountId: string, lease: Lease, controller: AbortController) {
    const { signal } = controller;
    const renew = setInterval(() => {
      void lease.renew().then((held) => {
        if (!held) {
          logger.warn({ accountId }, 'lost mailbox lease, disconnecting');
          controller.abort();
        }
      });
    }, leaseTtlMs / 3);

    let failures = 0;
    try {
      while (!signal.aborted) {
        // Read the account fresh each time so the sync cursor is never stale. A failed lookup is a
        // transient hiccup (e.g. a dropped database connection), not a reason to stop supervising.
        let account: ActiveAccount | undefined;
        try {
          account = (await internal.listAccounts()).find((a) => a.id === accountId);
        } catch (err) {
          failures += 1;
          logger.warn(
            { accountId, failures, err: (err as Error).message },
            'could not load account, will retry',
          );
          await sleep(backoffMs(failures), signal);
          continue;
        }
        if (!account || account.status === 'AUTH_FAILED') break;
        try {
          await runSession(account, { ...sessionDeps, internal, logger }, signal);
          failures = 0;
        } catch (err) {
          if (err instanceof AuthenticationFailedError) {
            const detail = err.serverResponse ? `: ${err.serverResponse}` : '';
            await internal.reportStatus(
              accountId,
              'AUTH_FAILED',
              `The mail server rejected the stored password${detail}`,
            );
            logger.warn(
              { accountId },
              'mailbox credentials rejected, stopping until they are updated',
            );
            break;
          }
          failures += 1;
          logger.warn(
            { accountId, failures, err: (err as Error).message },
            'mailbox session failed',
          );
          if (failures === UNREACHABLE_AFTER_FAILURES || (isAppError(err) && !err.retryable)) {
            await internal
              .reportStatus(accountId, 'UNREACHABLE', (err as Error).message)
              .catch(() => {});
          }
          if (isAppError(err) && !err.retryable) break;
        }
        if (!signal.aborted) await sleep(backoffMs(failures), signal);
      }
    } catch (err) {
      logger.error({ accountId, err }, 'mailbox supervisor crashed');
    } finally {
      clearInterval(renew);
      await lease.release().catch(() => {});
      running.delete(accountId);
      logger.info({ accountId }, 'mailbox disconnected');
    }
  }

  async function start(account: ActiveAccount) {
    const lease = createLease(redis, account.id, ownerId, leaseTtlMs);
    if (!(await lease.acquire())) return;
    const controller = new AbortController();
    running.set(account.id, { controller, done: supervise(account.id, lease, controller) });
    logger.info({ accountId: account.id, provider: account.provider }, 'mailbox connecting');
  }

  async function stop(accountId: string) {
    const entry = running.get(accountId);
    if (!entry) return;
    entry.controller.abort();
    await entry.done;
  }

  async function reconcile() {
    let accounts: ActiveAccount[];
    try {
      accounts = await internal.listAccounts();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'could not list accounts, will retry');
      return;
    }
    const wanted = new Map(
      accounts.filter((a) => a.status !== 'AUTH_FAILED').map((a) => [a.id, a]),
    );
    await Promise.all([
      ...[...wanted.values()].filter((a) => !running.has(a.id)).map(start),
      ...[...running.keys()].filter((id) => !wanted.has(id)).map(stop),
    ]);
  }

  const reconcileOnce = () =>
    (reconciling ??= reconcile().finally(() => (reconciling = undefined)));

  return {
    running: () => [...running.keys()],
    reconcile: reconcileOnce,
    start: () => {
      void reconcileOnce();
      timer = setInterval(() => void reconcileOnce(), reconcileIntervalMs);
    },
    close: async () => {
      clearInterval(timer);
      await reconciling;
      await Promise.all([...running.keys()].map(stop));
    },
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;
