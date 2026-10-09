import { currentUser, requireInternal } from '@onebox/auth-kit';
import { BILLING_INTERVALS, PLAN_IDS } from '@onebox/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Credits } from './credits/credits';
import { ACCOUNT_STATUSES, LEDGER_KINDS } from './db/schema';

const overview = z.object({
  subscription: z.object({
    plan: z.enum(PLAN_IDS),
    interval: z.enum(BILLING_INTERVALS).nullable(),
    status: z.enum(ACCOUNT_STATUSES),
    renewsAt: z.string().nullable(),
  }),
  balance: z.number(),
  periodCredits: z.number(),
  ledger: z.array(
    z.object({
      id: z.uuid(),
      at: z.string(),
      kind: z.enum(LEDGER_KINDS),
      description: z.string(),
      model: z.string().nullable(),
      credits: z.number(),
      balanceAfter: z.number(),
    }),
  ),
});

// Signed in: the user's plan, balance and credit history.
export function registerBillingRoutes(scope: FastifyInstance, credits: Credits) {
  scope
    .withTypeProvider<ZodTypeProvider>()
    .get('/', { schema: { response: { 200: overview } } }, async (request) =>
      credits.overview(currentUser(request).userId),
    );
}

// Other OneBox services ask this before spending credits; never routed by the gateway.
export function registerInternalRoutes(
  scope: FastifyInstance,
  credits: Credits,
  internalToken: string,
) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/allowance/:userId',
    {
      preHandler: requireInternal(internalToken),
      schema: {
        params: z.object({ userId: z.uuid() }),
        response: { 200: z.object({ allowed: z.boolean(), balance: z.number() }) },
      },
    },
    async (request) => credits.allowance(request.params.userId),
  );
}
