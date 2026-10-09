import { z } from 'zod';

// The plans users can be on. Prices are in paise; annual is the per-month price when paid
// yearly. Credits are per billing period (once, for Free). billing and payments share this.
export const PLAN_IDS = ['FREE', 'STANDARD', 'PRO'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const BILLING_INTERVALS = ['monthly', 'annual'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export interface PlanPrice {
  id: PlanId;
  name: string;
  monthlyPrice: number;
  annualMonthlyPrice: number;
  credits: number;
  bonusCredits: number;
}

export const PLAN_CATALOGUE: Record<PlanId, PlanPrice> = {
  FREE: {
    id: 'FREE',
    name: 'Free',
    monthlyPrice: 0,
    annualMonthlyPrice: 0,
    credits: 20,
    bonusCredits: 0,
  },
  STANDARD: {
    id: 'STANDARD',
    name: 'Standard',
    monthlyPrice: 49_900,
    annualMonthlyPrice: 41_500,
    credits: 500,
    bonusCredits: 250,
  },
  PRO: {
    id: 'PRO',
    name: 'Pro',
    monthlyPrice: 149_900,
    annualMonthlyPrice: 124_900,
    credits: 2_000,
    bonusCredits: 0,
  },
};

// What one billing period costs, in paise: a month, or a year paid up front.
export const periodPrice = (plan: PlanId, interval: BillingInterval) => {
  const { monthlyPrice, annualMonthlyPrice } = PLAN_CATALOGUE[plan];
  return interval === 'annual' ? annualMonthlyPrice * 12 : monthlyPrice;
};

// payments -> billing: what happened to a user's paid subscription, with no provider details.
export const PAYMENT_EVENT_TYPES = [
  // First successful payment: the plan starts now.
  'subscription.activated',
  // A later period was paid: grant that period's credits.
  'subscription.renewed',
  // Ends at the period end (or now); no more renewals.
  'subscription.cancelled',
  // Renewal payments failed repeatedly; the plan is paused until paid.
  'subscription.halted',
  'payment.failed',
] as const;

export const paymentEventPayloadSchema = z.object({
  type: z.enum(PAYMENT_EVENT_TYPES),
  subscriptionId: z.uuid(),
  plan: z.enum(PLAN_IDS),
  interval: z.enum(BILLING_INTERVALS),
  periodStart: z.iso.datetime().nullable(),
  periodEnd: z.iso.datetime().nullable(),
  // The payment behind activated/renewed/failed, so a period is granted once per payment.
  paymentId: z.string().min(1).nullable(),
  occurredAt: z.iso.datetime(),
});

export type PaymentEventPayload = z.infer<typeof paymentEventPayloadSchema>;
