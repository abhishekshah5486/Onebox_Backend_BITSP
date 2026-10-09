import { currentUser } from '@onebox/auth-kit';
import { BILLING_INTERVALS, PLAN_IDS } from '@onebox/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PAYMENT_PROVIDERS, PAYMENT_STATUSES, SUBSCRIPTION_STATUSES } from '../db/schema';
import type { CheckoutService } from './checkout-service';

const subscription = z.object({
  id: z.uuid(),
  provider: z.enum(PAYMENT_PROVIDERS),
  plan: z.enum(PLAN_IDS),
  interval: z.enum(BILLING_INTERVALS),
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  createdAt: z.string(),
});

// Fields every checkout answer carries, whichever provider opens it.
const opened = {
  plan: z.enum(PLAN_IDS),
  interval: z.enum(BILLING_INTERVALS),
  amount: z.number(),
  currency: z.string(),
  email: z.string(),
};

export function registerCheckoutRoutes(scope: FastifyInstance, checkout: CheckoutService) {
  const routes = scope.withTypeProvider<ZodTypeProvider>();
  const user = (request: Parameters<typeof currentUser>[0]) => currentUser(request);

  routes.get(
    '/config',
    { schema: { response: { 200: z.object({ providers: z.array(z.enum(PAYMENT_PROVIDERS)) }) } } },
    async () => ({ providers: checkout.providers() }),
  );

  routes.post(
    '/checkout',
    {
      schema: {
        body: z.object({
          plan: z.enum(PLAN_IDS),
          interval: z.enum(BILLING_INTERVALS),
          provider: z.enum(PAYMENT_PROVIDERS).optional(),
        }),
        response: {
          200: z.discriminatedUnion('provider', [
            z.object({
              ...opened,
              provider: z.literal('RAZORPAY'),
              keyId: z.string(),
              subscriptionId: z.string(),
            }),
            z.object({
              ...opened,
              provider: z.literal('STRIPE'),
              sessionId: z.string(),
              url: z.string(),
            }),
          ]),
        },
      },
    },
    async (request) => {
      const { userId, email } = user(request);
      const { plan, interval, provider } = request.body;
      return checkout.start({ userId, email }, plan, interval, provider);
    },
  );

  routes.get(
    '/checkout/:id/status',
    {
      schema: {
        params: z.object({ id: z.string().min(1).max(200) }),
        response: {
          200: z.object({
            state: z.enum(['open', 'paid', 'expired']),
            subscription: subscription.nullable(),
          }),
        },
      },
    },
    async (request) => checkout.checkoutStatus(user(request).userId, request.params.id),
  );

  routes.post(
    '/checkout/confirm',
    {
      schema: {
        body: z.object({
          paymentId: z.string().min(1).max(100),
          subscriptionId: z.string().min(1).max(100),
          signature: z.string().min(1).max(200),
        }),
        response: { 200: subscription },
      },
    },
    async (request) => checkout.confirm(user(request).userId, request.body),
  );

  routes.get(
    '/subscription',
    { schema: { response: { 200: z.object({ subscription: subscription.nullable() }) } } },
    async (request) => ({ subscription: await checkout.current(user(request).userId) }),
  );

  routes.post(
    '/subscription/cancel',
    { schema: { response: { 200: subscription } } },
    async (request) => checkout.cancel(user(request).userId),
  );

  routes.get(
    '/history',
    {
      schema: {
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.uuid(),
                amount: z.number(),
                currency: z.string(),
                status: z.enum(PAYMENT_STATUSES),
                method: z.string().nullable(),
                failureReason: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => ({ items: await checkout.history(user(request).userId) }),
  );
}
