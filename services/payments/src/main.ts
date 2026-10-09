import { createRemoteTokenVerifier } from '@onebox/auth-kit';
import { QUEUES, type PaymentEventPayload } from '@onebox/contracts';
import { createPgClient } from '@onebox/db-pg';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { createProducer } from '@onebox/queue';
import { buildApp } from './app';
import { createCheckoutService } from './checkout/checkout-service';
import { loadPaymentsConfig, razorpayKeys, stripeKey } from './config';
import { migratePayments } from './db/migrate';
import { createRazorpay } from './providers/razorpay';
import { createStripe } from './providers/stripe';
import { createRazorpayWebhooks } from './webhooks/razorpay-webhooks';
import { createStripeWebhooks } from './webhooks/stripe-webhooks';

const logger = createLogger({ service: 'payments', pretty: process.stdout.isTTY });
const config = loadPaymentsConfig();
const pg = createPgClient(config.DATABASE_URL);

await pg.ping();
logger.info('database connected');
await migratePayments(pg, logger);

const keys = razorpayKeys(config);
const razorpay = keys
  ? createRazorpay({ ...keys, webhookSecret: config.RAZORPAY_WEBHOOK_SECRET }, logger)
  : null;
const secretKey = stripeKey(config);
const stripe = secretKey
  ? createStripe({ secretKey, webhookSecret: config.STRIPE_WEBHOOK_SECRET }, logger)
  : null;
logger.info(
  {
    mode: config.PAYMENTS_MODE,
    razorpay: razorpay !== null,
    stripe: stripe !== null,
    webhooks: { razorpay: razorpay?.hasWebhookSecret, stripe: stripe?.hasWebhookSecret },
  },
  'payment providers configured',
);

// Payment events go to billing, which grants or removes plans and credits.
const events = createProducer<PaymentEventPayload>(QUEUES.payments, {
  redisUrl: config.REDIS_URL,
  logger,
});

const app = buildApp({
  logger,
  pingDatabase: pg.ping,
  routes: {
    checkout: createCheckoutService({
      db: pg.db,
      razorpay,
      stripe,
      defaultProvider: config.DEFAULT_PAYMENT_PROVIDER === 'stripe' ? 'STRIPE' : 'RAZORPAY',
      publicApiUrl: config.PUBLIC_API_URL,
      events,
      logger,
    }),
    webhooks: {
      razorpay:
        razorpay?.hasWebhookSecret === true
          ? createRazorpayWebhooks({ db: pg.db, razorpay, events, logger })
          : null,
      stripe:
        stripe?.hasWebhookSecret === true
          ? createStripeWebhooks({ db: pg.db, stripe, events, logger })
          : null,
    },
    verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
  },
});
await startServer(app, { port: config.PORT, cleanups: [pg.close, events.close] });
