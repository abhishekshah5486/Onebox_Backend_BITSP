import { currentUser } from '@onebox/auth-kit';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AUTONOMY_MODES } from '../db/schema';
import type { PreferencesService } from './preferences-service';

// Intl accepts every IANA name and alias (Asia/Kolkata and Asia/Calcutta alike).
function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezone = z.string().max(64).refine(isTimeZone, {
  message: 'must be an IANA time zone such as Asia/Kolkata',
});

const preferencesView = z.object({
  markSeenOnFetch: z.boolean(),
  autonomyMode: z.enum(AUTONOMY_MODES),
  signature: z.string().nullable(),
  timezone: z.string(),
  updatedAt: z.string().nullable(),
});

const updateBody = z
  .object({
    markSeenOnFetch: z.boolean().optional(),
    autonomyMode: z.enum(AUTONOMY_MODES).optional(),
    signature: z.string().max(2000).nullable().optional(),
    timezone: timezone.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one preference to update',
  });

export function registerPreferenceRoutes(scope: FastifyInstance, preferences: PreferencesService) {
  const routes = scope.withTypeProvider<ZodTypeProvider>();

  routes.get('/preferences', { schema: { response: { 200: preferencesView } } }, async (request) =>
    preferences.get(currentUser(request).userId),
  );

  routes.patch(
    '/preferences',
    { schema: { body: updateBody, response: { 200: preferencesView } } },
    async (request) => {
      const changes = Object.fromEntries(
        Object.entries(request.body).filter(([, value]) => value !== undefined),
      );
      return preferences.update(currentUser(request).userId, changes);
    },
  );
}
