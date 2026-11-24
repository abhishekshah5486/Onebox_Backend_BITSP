import { BILLING_INTERVALS, PLAN_IDS } from '@onebox/contracts';
import { sql } from 'drizzle-orm';
import { boolean, index, numeric, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const billing = pgSchema('billing');

export const planEnum = billing.enum('plan', PLAN_IDS);
export const intervalEnum = billing.enum('billing_interval', BILLING_INTERVALS);
// free: no paid plan. past_due: a renewal failed and is being retried. halted: retries ran out.
export const ACCOUNT_STATUSES = ['free', 'active', 'past_due', 'halted'] as const;
export const accountStatusEnum = billing.enum('account_status', ACCOUNT_STATUSES);
export const LEDGER_KINDS = ['grant', 'charge', 'refund', 'expiry'] as const;
export const ledgerKindEnum = billing.enum('ledger_kind', LEDGER_KINDS);

const credits = (name: string) =>
  numeric(name, { precision: 14, scale: 3, mode: 'number' }).notNull().default(0);

// One row per user: their plan and credit balance. Made on first use, on Free.
export const accounts = billing.table('accounts', {
  userId: uuid('user_id').primaryKey(),
  plan: planEnum('plan').notNull().default('FREE'),
  interval: intervalEnum('interval'),
  status: accountStatusEnum('status').notNull().default('free'),
  // The payments service's subscription behind a paid plan.
  subscriptionId: uuid('subscription_id'),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  // When this month's credits are replaced; annual plans refill monthly within the paid year.
  nextRefillAt: timestamp('next_refill_at', { withTimezone: true }),
  balance: credits('balance'),
  // Credits given for the current month, for "used x of y".
  periodCredits: credits('period_credits'),
  bonusGiven: boolean('bonus_given').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Every change to a balance. The source key makes each one happen once (a payment, a call...).
export const ledger = billing.table(
  'ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    kind: ledgerKindEnum('kind').notNull(),
    credits: credits('credits'),
    balanceAfter: credits('balance_after'),
    description: text('description').notNull(),
    model: text('model'),
    // The model's id (e.g. perplexity/glm-5.3-flash), for its maker's logo.
    modelId: text('model_id'),
    sourceKey: text('source_key').notNull().unique(),
    // The moment of the change itself, so lines from one transaction keep their order.
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [index('ledger_user_created_idx').on(table.userId, table.createdAt)],
);

// Payment events already applied, by job id, so a redelivery changes nothing.
export const processedEvents = billing.table('processed_events', {
  jobId: text('job_id').primaryKey(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AccountRow = typeof accounts.$inferSelect;
export type LedgerRow = typeof ledger.$inferSelect;
