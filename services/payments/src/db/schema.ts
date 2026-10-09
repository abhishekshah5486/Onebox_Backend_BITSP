import { BILLING_INTERVALS, PLAN_IDS } from '@onebox/contracts';
import {
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';

export const paymentsSchema = pgSchema('payments');

export const PAYMENT_PROVIDERS = ['RAZORPAY', 'STRIPE'] as const;
// Razorpay's subscription states, which cover what Stripe needs too.
export const SUBSCRIPTION_STATUSES = [
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'cancelled',
  'completed',
  'expired',
] as const;
export const PAYMENT_STATUSES = ['captured', 'failed', 'refunded'] as const;

export const providerEnum = paymentsSchema.enum('provider', PAYMENT_PROVIDERS);
export const planEnum = paymentsSchema.enum('plan', PLAN_IDS);
export const intervalEnum = paymentsSchema.enum('billing_interval', BILLING_INTERVALS);
export const subscriptionStatusEnum = paymentsSchema.enum(
  'subscription_status',
  SUBSCRIPTION_STATUSES,
);
export const paymentStatusEnum = paymentsSchema.enum('payment_status', PAYMENT_STATUSES);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// The provider's customer for a user, made once and reused.
export const customers = paymentsSchema.table(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    provider: providerEnum('provider').notNull(),
    providerCustomerId: text('provider_customer_id').notNull(),
    email: text('email').notNull(),
    ...timestamps,
  },
  (table) => [unique('customers_user_provider_unique').on(table.userId, table.provider)],
);

// Each plan and interval as a plan on the provider's side, created on first use.
export const providerPlans = paymentsSchema.table(
  'provider_plans',
  {
    provider: providerEnum('provider').notNull(),
    plan: planEnum('plan').notNull(),
    interval: intervalEnum('interval').notNull(),
    // The price it was created at; a new price means a new provider plan.
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    providerPlanId: text('provider_plan_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('provider_plans_unique').on(
      table.provider,
      table.plan,
      table.interval,
      table.amount,
      table.currency,
    ),
  ],
);

export const subscriptions = paymentsSchema.table(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    provider: providerEnum('provider').notNull(),
    providerSubscriptionId: text('provider_subscription_id').notNull().unique(),
    // The provider's checkout that started it (a Stripe Checkout Session); none for Razorpay.
    checkoutId: text('checkout_id').unique(),
    plan: planEnum('plan').notNull(),
    interval: intervalEnum('interval').notNull(),
    status: subscriptionStatusEnum('status').notNull().default('created'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    ...timestamps,
  },
  (table) => [index('subscriptions_user_idx').on(table.userId)],
);

export const payments = paymentsSchema.table(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    provider: providerEnum('provider').notNull(),
    providerPaymentId: text('provider_payment_id').notNull().unique(),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    status: paymentStatusEnum('status').notNull(),
    method: text('method'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('payments_user_idx').on(table.userId)],
);

// Every webhook received, kept once by the provider's event id so retries are not reapplied.
export const webhookEvents = paymentsSchema.table(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: providerEnum('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (table) => [unique('webhook_events_unique').on(table.provider, table.eventId)],
);

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
