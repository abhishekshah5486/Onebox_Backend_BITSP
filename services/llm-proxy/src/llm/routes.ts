import { currentUser, requireInternal, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import type { HttpServer } from '@onebox/http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PROVIDERS, PURPOSES } from '../db/schema';
import { AUTO, type Catalog } from './catalog';
import type { Completer } from './complete';
import type { Usage } from './usage';

const message = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(200_000),
});

const completeBody = z.object({
  userId: z.uuid(),
  purpose: z.enum(PURPOSES),
  messages: z.array(message).min(1).max(50),
  schema: z
    .object({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      schema: z.record(z.string(), z.unknown()),
    })
    .optional(),
  model: z.string().max(100).optional(),
  maxOutputTokens: z.number().int().min(16).max(32_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  cache: z.boolean().optional(),
  subject: z.string().max(200).optional(),
  traceId: z.string().max(100).optional(),
});

export function registerLlmRoutes(
  app: HttpServer,
  deps: {
    catalog: Catalog;
    complete: Completer;
    usage: Usage;
    verifyToken: TokenVerifier;
    internalToken: string;
  },
) {
  const { catalog, complete, usage } = deps;
  app.decorateRequest('user', null);

  // Other OneBox services call this; it is never routed by the gateway.
  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/internal/complete',
      { preHandler: requireInternal(deps.internalToken), schema: { body: completeBody } },
      async (request) => complete(request.body),
    );

  void app.register(
    async (scope) => {
      const routes = scope.withTypeProvider<ZodTypeProvider>();
      routes.addHook('preHandler', requireUser(deps.verifyToken));
      const userId = (request: Parameters<typeof currentUser>[0]) => currentUser(request).userId;

      routes.get(
        '/models',
        {
          schema: {
            response: {
              200: z.object({
                items: z.array(
                  z.object({
                    id: z.string(),
                    provider: z.enum(PROVIDERS),
                    name: z.string(),
                    description: z.string(),
                    available: z.boolean(),
                  }),
                ),
                purposes: z.array(z.enum(PURPOSES)),
                choices: z.record(z.string(), z.string()),
              }),
            },
          },
        },
        async (request) => ({
          items: await catalog.list(),
          purposes: [...PURPOSES],
          choices: await catalog.choices(userId(request)),
        }),
      );

      routes.put(
        '/choices/:purpose',
        {
          schema: {
            params: z.object({ purpose: z.enum(PURPOSES) }),
            body: z.object({ modelId: z.string().min(1).max(100) }),
          },
        },
        async (request, reply) => {
          await catalog.choose(userId(request), request.params.purpose, request.body.modelId);
          return reply.status(204).send();
        },
      );

      routes.get(
        '/usage',
        {
          schema: {
            querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
          },
        },
        async (request) => usage(userId(request), request.query.days),
      );
    },
    { prefix: '/llm' },
  );
}

export { AUTO };
