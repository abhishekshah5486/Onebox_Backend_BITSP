import { envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4008),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres connection string'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  // Test keys while building; live keys only where real payments are taken.
  PAYMENTS_MODE: z.enum(['test', 'live']).default('test'),
  // Where checkout goes when both are set up and the user doesn't choose.
  DEFAULT_PAYMENT_PROVIDER: z.enum(['razorpay', 'stripe']).default('razorpay'),
  RAZORPAY_TEST_API_KEY: z.string().startsWith('rzp_test_').optional(),
  RAZORPAY_TEST_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_LIVE_API_KEY: z.string().startsWith('rzp_live_').optional(),
  RAZORPAY_LIVE_KEY_SECRET: z.string().min(1).optional(),
  // Signs Razorpay's webhooks; set when the webhook is registered in the dashboard.
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_TEST_SECRET_KEY: z.string().startsWith('sk_test_').optional(),
  STRIPE_TEST_PUBLISHABLE_KEY: z.string().startsWith('pk_test_').optional(),
  STRIPE_LIVE_SECRET_KEY: z.string().startsWith('sk_live_').optional(),
  STRIPE_LIVE_PUBLISHABLE_KEY: z.string().startsWith('pk_live_').optional(),
  // From `stripe listen` locally, or the webhook endpoint in Stripe's dashboard.
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  // Public address of the gateway; Stripe sends the browser back here after checkout.
  PUBLIC_API_URL: z.url().default('http://localhost:4000/api/v1'),
});

export type PaymentsConfig = z.infer<typeof schema>;

export const loadPaymentsConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(schema, env);

// The Razorpay keys for the configured mode, or null when they are not set.
export function razorpayKeys(config: PaymentsConfig) {
  const keyId =
    config.PAYMENTS_MODE === 'live' ? config.RAZORPAY_LIVE_API_KEY : config.RAZORPAY_TEST_API_KEY;
  const keySecret =
    config.PAYMENTS_MODE === 'live'
      ? config.RAZORPAY_LIVE_KEY_SECRET
      : config.RAZORPAY_TEST_KEY_SECRET;
  return keyId && keySecret ? { keyId, keySecret } : null;
}

// The Stripe secret key for the configured mode, or null when it is not set.
export function stripeKey(config: PaymentsConfig) {
  return (
    (config.PAYMENTS_MODE === 'live'
      ? config.STRIPE_LIVE_SECRET_KEY
      : config.STRIPE_TEST_SECRET_KEY) ?? null
  );
}
