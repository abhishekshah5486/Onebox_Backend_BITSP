import {
  PLAN_CATALOGUE,
  type PaymentEventPayload,
  type PlanId,
  type UsageEventPayload,
} from '@onebox/contracts';
import type { Logger } from '@onebox/logger';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { accounts, ledger, processedEvents, type AccountRow, type LedgerRow } from '../db/schema';

type Db = PostgresJsDatabase;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Credits have two decimals; a paid call always uses at least the smallest step.
const round = (value: number) => Math.round(value * 100) / 100;
const MIN_CHARGE = 0.01;

const addMonth = (date: Date) => {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
};

// What each AI purpose did, in the words the credit history uses.
const ACTIVITY: Record<string, string> = {
  classify: 'Sorted an email into labels',
  extract: 'Read details from an email',
  draft: 'Drafted a reply',
  summarize: 'Summarised a conversation',
};

export function createCredits({
  db,
  creditsPerUsd,
  logger,
}: {
  db: Db;
  creditsPerUsd: number;
  logger: Logger;
}) {
  // The user's account, locked for this transaction; a new user starts on Free with its credits.
  async function lockAccount(tx: Tx, userId: string): Promise<AccountRow> {
    const [created] = await tx
      .insert(accounts)
      .values({ userId })
      .onConflictDoNothing()
      .returning();
    if (created) {
      const free = PLAN_CATALOGUE.FREE.credits;
      await entry(tx, created, {
        kind: 'grant',
        credits: free,
        description: 'Free plan credits',
        sourceKey: `free-${userId}`,
      });
      await tx.update(accounts).set({ periodCredits: free }).where(eq(accounts.userId, userId));
    }
    const [row] = await tx.select().from(accounts).where(eq(accounts.userId, userId)).for('update');
    return row!;
  }

  // Adds one ledger line and moves the balance with it; false if that source already counted.
  async function entry(
    tx: Tx,
    account: AccountRow,
    line: Pick<LedgerRow, 'kind' | 'description' | 'sourceKey'> & {
      credits: number;
      model?: string | null;
    },
  ) {
    const credits = round(line.credits);
    const [current] = await tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.userId, account.userId));
    const balanceAfter = round((current?.balance ?? 0) + credits);
    const [added] = await tx
      .insert(ledger)
      .values({
        userId: account.userId,
        kind: line.kind,
        credits,
        balanceAfter,
        description: line.description,
        model: line.model ?? null,
        sourceKey: line.sourceKey,
      })
      .onConflictDoNothing()
      .returning({ id: ledger.id });
    if (!added) return false;
    await tx
      .update(accounts)
      .set({ balance: balanceAfter, updatedAt: new Date() })
      .where(eq(accounts.userId, account.userId));
    return true;
  }

  // A new month of a plan: what is left expires and the plan's credits are given.
  async function startMonth(tx: Tx, account: AccountRow, plan: PlanId, key: string) {
    const details = PLAN_CATALOGUE[plan];
    const [current] = await tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.userId, account.userId));
    const left = current?.balance ?? 0;
    if (left > 0) {
      await entry(tx, account, {
        kind: 'expiry',
        credits: -left,
        description: 'Unused credits expired',
        sourceKey: `expiry-${key}`,
      });
    }
    const granted = await entry(tx, account, {
      kind: 'grant',
      credits: details.credits,
      description: `${details.name} plan credits`,
      sourceKey: `grant-${key}`,
    });
    // Already given for this payment (or month): nothing else changes either.
    if (!granted) return;
    let periodCredits = details.credits;
    if (details.bonusCredits > 0 && !account.bonusGiven) {
      await entry(tx, account, {
        kind: 'grant',
        credits: details.bonusCredits,
        description: 'First-month bonus credits',
        sourceKey: `bonus-${account.userId}`,
      });
      periodCredits += details.bonusCredits;
      await tx
        .update(accounts)
        .set({ bonusGiven: true })
        .where(eq(accounts.userId, account.userId));
    }
    await tx.update(accounts).set({ periodCredits }).where(eq(accounts.userId, account.userId));
  }

  return {
    // Applies one payment event; a redelivered job changes nothing.
    async applyPayment(jobId: string, userId: string, event: PaymentEventPayload) {
      await db.transaction(async (tx) => {
        const [fresh] = await tx
          .insert(processedEvents)
          .values({ jobId })
          .onConflictDoNothing()
          .returning();
        if (!fresh) return;
        const account = await lockAccount(tx, userId);
        const periodStart = event.periodStart ? new Date(event.periodStart) : new Date();
        const periodEnd = event.periodEnd ? new Date(event.periodEnd) : null;
        const key = event.paymentId ?? jobId;

        switch (event.type) {
          case 'subscription.activated':
          case 'subscription.renewed':
          case 'subscription.changed':
            await tx
              .update(accounts)
              .set({
                plan: event.plan,
                interval: event.interval,
                status: 'active',
                subscriptionId: event.subscriptionId,
                periodEnd,
                nextRefillAt: addMonth(periodStart),
              })
              .where(eq(accounts.userId, userId));
            await startMonth(tx, account, event.plan, `${event.type}-${key}`);
            break;
          case 'subscription.cancelled': {
            // Another subscription may already have replaced this one.
            if (account.subscriptionId && account.subscriptionId !== event.subscriptionId) break;
            const [current] = await tx
              .select({ balance: accounts.balance })
              .from(accounts)
              .where(eq(accounts.userId, userId));
            if ((current?.balance ?? 0) > 0) {
              await entry(tx, account, {
                kind: 'expiry',
                credits: -current!.balance,
                description: 'Plan ended, unused credits expired',
                sourceKey: `ended-${event.subscriptionId}`,
              });
            }
            await tx
              .update(accounts)
              .set({
                plan: 'FREE',
                interval: null,
                status: 'free',
                subscriptionId: null,
                periodEnd: null,
                nextRefillAt: null,
                periodCredits: 0,
              })
              .where(eq(accounts.userId, userId));
            break;
          }
          case 'subscription.halted':
            await tx.update(accounts).set({ status: 'halted' }).where(eq(accounts.userId, userId));
            break;
          case 'payment.failed':
            if (account.status === 'active') {
              await tx
                .update(accounts)
                .set({ status: 'past_due' })
                .where(eq(accounts.userId, userId));
            }
            break;
        }
      });
      logger.info({ userId, type: event.type, plan: event.plan }, 'payment event applied');
    },

    // Charges one model call, once.
    async charge(userId: string, usage: UsageEventPayload) {
      const credits = Math.max(MIN_CHARGE, round(usage.costUsd * creditsPerUsd));
      await db.transaction(async (tx) => {
        const account = await lockAccount(tx, userId);
        await entry(tx, account, {
          kind: 'charge',
          credits: -credits,
          description: ACTIVITY[usage.purpose] ?? 'Used an AI feature',
          model: usage.modelName,
          sourceKey: `call-${usage.callId}`,
        });
      });
    },

    // Whether AI features may run: credits left, and a plan that isn't stopped for non-payment.
    async allowance(userId: string) {
      const account = await db.transaction((tx) => lockAccount(tx, userId));
      return {
        allowed: account.balance > 0 && account.status !== 'halted',
        balance: account.balance,
      };
    },

    // Gives annual plans their next month of credits; monthly plans get theirs when renewed.
    async refillDue(now = new Date()) {
      const due = await db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(
          and(
            eq(accounts.status, 'active'),
            lte(accounts.nextRefillAt, now),
            // A month that starts within a day of the paid period's end waits for the renewal.
            sql`${accounts.nextRefillAt} < ${accounts.periodEnd} - interval '1 day'`,
          ),
        );
      for (const { userId } of due) {
        await db.transaction(async (tx) => {
          const account = await lockAccount(tx, userId);
          if (!account.nextRefillAt || account.nextRefillAt > now) return;
          await startMonth(
            tx,
            account,
            account.plan,
            `refill-${userId}-${account.nextRefillAt.toISOString()}`,
          );
          await tx
            .update(accounts)
            .set({ nextRefillAt: addMonth(account.nextRefillAt) })
            .where(eq(accounts.userId, userId));
        });
      }
      if (due.length > 0) logger.info({ accounts: due.length }, 'monthly credits refilled');
      return due.length;
    },

    // What Settings → Billing shows.
    async overview(userId: string) {
      const account = await db.transaction((tx) => lockAccount(tx, userId));
      const lines = await db
        .select()
        .from(ledger)
        .where(eq(ledger.userId, userId))
        .orderBy(desc(ledger.createdAt), desc(ledger.id))
        .limit(200);
      return {
        subscription: {
          plan: account.plan,
          interval: account.interval,
          status: account.status,
          renewsAt:
            (account.plan === 'FREE'
              ? null
              : (account.nextRefillAt ?? account.periodEnd)
            )?.toISOString() ?? null,
        },
        balance: account.balance,
        periodCredits: account.periodCredits,
        ledger: lines.map((line) => ({
          id: line.id,
          at: line.createdAt.toISOString(),
          kind: line.kind,
          description: line.description,
          model: line.model,
          credits: line.credits,
          balanceAfter: line.balanceAfter,
        })),
      };
    },
  };
}

export type Credits = ReturnType<typeof createCredits>;
