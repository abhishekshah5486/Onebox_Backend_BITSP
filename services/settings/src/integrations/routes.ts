import { currentUser } from '@onebox/auth-kit';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { INTEGRATION_EVENTS, INTEGRATION_TYPES } from '../db/schema';
import type { IntegrationService } from './integration-service';

const name = z.string().trim().min(1).max(80);
const url = z.url().max(2048);
const events = z.array(z.enum(INTEGRATION_EVENTS)).min(1).max(INTEGRATION_EVENTS.length);
const defaultEvents = events.default(['email.interested']);

const createBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SLACK'), name, webhookUrl: url, events: defaultEvents }),
  z.object({ type: z.literal('WEBHOOK'), name, url, events: defaultEvents }),
]);

const updateBody = z
  .object({
    name: name.optional(),
    enabled: z.boolean().optional(),
    events: events.optional(),
    url: url.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

const integrationView = z.object({
  id: z.uuid(),
  type: z.enum(INTEGRATION_TYPES),
  name: z.string(),
  target: z.string(),
  events: z.array(z.enum(INTEGRATION_EVENTS)),
  enabled: z.boolean(),
  lastTestedAt: z.string().nullable(),
  lastTestOk: z.boolean().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const withSecret = integrationView.extend({ secret: z.string().optional() });
const params = z.object({ id: z.uuid() });

export function registerIntegrationRoutes(
  scope: FastifyInstance,
  integrations: IntegrationService,
) {
  const routes = scope.withTypeProvider<ZodTypeProvider>();
  const userId = (request: Parameters<typeof currentUser>[0]) => currentUser(request).userId;

  routes.get(
    '/integrations',
    { schema: { response: { 200: z.object({ items: z.array(integrationView) }) } } },
    async (request) => ({ items: await integrations.list(userId(request)) }),
  );

  routes.post(
    '/integrations',
    { schema: { body: createBody, response: { 201: withSecret } } },
    async (request, reply) =>
      reply.status(201).send(await integrations.create(userId(request), request.body)),
  );

  routes.get(
    '/integrations/:id',
    { schema: { params, response: { 200: integrationView } } },
    async (request) => integrations.get(userId(request), request.params.id),
  );

  routes.patch(
    '/integrations/:id',
    { schema: { params, body: updateBody, response: { 200: integrationView } } },
    async (request) => {
      const { url: target, ...rest } = request.body;
      return integrations.update(userId(request), request.params.id, { ...rest, target });
    },
  );

  routes.post(
    '/integrations/:id/test',
    {
      schema: {
        params,
        response: {
          200: z.object({
            ok: z.boolean(),
            status: z.number().optional(),
            error: z.string().optional(),
            integration: integrationView,
          }),
        },
      },
    },
    async (request) => integrations.test(userId(request), request.params.id),
  );

  routes.post(
    '/integrations/:id/rotate-secret',
    { schema: { params, response: { 200: withSecret } } },
    async (request) => integrations.rotateSecret(userId(request), request.params.id),
  );

  routes.delete('/integrations/:id', { schema: { params } }, async (request, reply) => {
    await integrations.remove(userId(request), request.params.id);
    return reply.status(204).send();
  });
}
