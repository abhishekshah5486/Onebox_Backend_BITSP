import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { backoffMs } from './supervisor';

describe('backoffMs', () => {
  it('grows exponentially with jitter between 50% and 100%', () => {
    expect(backoffMs(1, () => 0)).toBe(1000);
    expect(backoffMs(1, () => 1)).toBe(2000);
    expect(backoffMs(4, () => 1)).toBe(16_000);
  });

  it('caps at five minutes', () => {
    expect(backoffMs(30, () => 1)).toBe(300_000);
  });
});

describe('createSupervisor', () => {
  it('keeps supervising when an account lookup fails transiently', async () => {
    const { createSupervisor } = await import('./supervisor');
    const { createLogger } = await import('@onebox/logger');
    const account = {
      id: 'acc-1',
      userId: 'u1',
      provider: 'IMAP',
      emailAddress: 'a@x.example',
      status: 'CONNECTED' as const,
      updatedAt: '2026-10-07T00:00:00Z',
      syncState: {},
    };
    let lookups = 0;
    const sessions: string[] = [];
    const internal = {
      listAccounts: async () => {
        lookups += 1;
        // First call is the reconcile; the second (inside supervision) fails once.
        if (lookups === 2) throw new Error('HTTP 500');
        return [account];
      },
      getCredentials: async () => {
        throw new Error('unused');
      },
      saveSyncState: async () => {},
      reportStatus: async () => {},
      getPreferences: async () => ({ markSeenOnFetch: false }),
    };
    const redis = {
      set: async () => 'OK',
      eval: async () => 1,
    } as unknown as Redis;

    const supervisor = createSupervisor({
      internal,
      redis,
      logger: createLogger({ service: 'test', level: 'silent' }),
      ownerId: 'test',
      reconcileIntervalMs: 60_000,
      sessionDeps: {} as never,
      runSession: async (_account, _deps, signal) => {
        sessions.push('started');
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
      },
    });

    await supervisor.reconcile();
    await vi.waitFor(() => expect(sessions).toEqual(['started']), { timeout: 5000 });
    expect(supervisor.running()).toEqual(['acc-1']);
    await supervisor.close();
  });

  it('takes back an expired lease, and disconnects only when another process holds it', async () => {
    const { createSupervisor } = await import('./supervisor');
    const { createLogger } = await import('@onebox/logger');
    const account = {
      id: 'acc-2',
      userId: 'u1',
      provider: 'IMAP',
      emailAddress: 'b@x.example',
      status: 'CONNECTED' as const,
      updatedAt: '2026-10-07T00:00:00Z',
      syncState: {},
    };
    // Renewals always fail, as after a Redis blip; the key is free until another owner takes it.
    let takenElsewhere = false;
    const redis = {
      set: async () => (takenElsewhere ? null : 'OK'),
      eval: async () => 0,
    } as unknown as Redis;
    let aborted = false;
    const supervisor = createSupervisor({
      internal: {
        listAccounts: async () => [account],
        getCredentials: async () => {
          throw new Error('unused');
        },
        saveSyncState: async () => {},
        reportStatus: async () => {},
        getPreferences: async () => ({ markSeenOnFetch: false }),
      },
      redis,
      logger: createLogger({ service: 'test', level: 'silent' }),
      ownerId: 'test',
      reconcileIntervalMs: 60_000,
      leaseTtlMs: 60,
      sessionDeps: {} as never,
      runSession: async (_account, _deps, signal) => {
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
        aborted = true;
      },
    });

    await supervisor.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(aborted).toBe(false);

    takenElsewhere = true;
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 2000 });
    await supervisor.close();
  });

  it('never runs two lease renewals at once, even when Redis is slow', async () => {
    const { createSupervisor } = await import('./supervisor');
    const { createLogger } = await import('@onebox/logger');
    let active = 0;
    let most = 0;
    const redis = {
      set: async () => 'OK',
      // Each renewal takes longer than the gap between ticks.
      eval: async () => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 70));
        active -= 1;
        return 1;
      },
    } as unknown as Redis;
    const supervisor = createSupervisor({
      internal: {
        listAccounts: async () => [
          {
            id: 'acc-3',
            userId: 'u1',
            provider: 'IMAP',
            emailAddress: 'c@x.example',
            status: 'CONNECTED' as const,
            updatedAt: '2026-10-07T00:00:00Z',
            syncState: {},
          },
        ],
        getCredentials: async () => {
          throw new Error('unused');
        },
        saveSyncState: async () => {},
        reportStatus: async () => {},
        getPreferences: async () => ({ markSeenOnFetch: false }),
      },
      redis,
      logger: createLogger({ service: 'test', level: 'silent' }),
      ownerId: 'test',
      reconcileIntervalMs: 60_000,
      leaseTtlMs: 60,
      sessionDeps: {} as never,
      runSession: async (_account, _deps, signal) => {
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
      },
    });

    await supervisor.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await supervisor.close();
    expect(most).toBe(1);
  });
});
