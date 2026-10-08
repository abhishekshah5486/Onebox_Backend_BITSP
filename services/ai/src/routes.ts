import { currentUser, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { AI_LABEL_MODES } from '@onebox/contracts';
import type { HttpServer } from '@onebox/http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { LabelRules } from './labels/label-rules';
import type { Suggestions } from './suggestions/suggestions';

const path = z.string().min(1).max(500);

export function registerAiRoutes(
  app: HttpServer,
  deps: { labels: LabelRules; suggestions: Suggestions; verifyToken: TokenVerifier },
) {
  const { labels, suggestions } = deps;
  app.decorateRequest('user', null);

  void app.register(
    async (scope) => {
      const routes = scope.withTypeProvider<ZodTypeProvider>();
      routes.addHook('preHandler', requireUser(deps.verifyToken));
      const userId = (request: Parameters<typeof currentUser>[0]) => currentUser(request).userId;

      routes.get(
        '/labels',
        { schema: { querystring: z.object({ accountId: z.uuid().optional() }) } },
        async (request) => ({ items: await labels.list(userId(request), request.query.accountId) }),
      );

      routes.put(
        '/labels',
        {
          schema: {
            body: z.object({
              accountId: z.uuid(),
              path,
              name: z.string().min(1).max(500),
              description: z.string().max(1000),
              mode: z.enum(AI_LABEL_MODES),
              threshold: z.number().min(0).max(1).optional(),
            }),
          },
        },
        async (request) => labels.save(userId(request), request.body),
      );

      routes.post(
        '/labels/move',
        {
          schema: {
            body: z.object({
              accountId: z.uuid(),
              from: path,
              to: path,
              name: z.string().min(1).max(500),
            }),
          },
        },
        async (request, reply) => {
          const { accountId, from, to, name } = request.body;
          await labels.move(userId(request), accountId, from, to, name);
          return reply.status(204).send();
        },
      );

      routes.post(
        '/labels/delete',
        { schema: { body: z.object({ accountId: z.uuid(), path }) } },
        async (request, reply) => {
          await labels.remove(userId(request), request.body.accountId, request.body.path);
          return reply.status(204).send();
        },
      );

      routes.get(
        '/suggestions',
        {
          schema: {
            querystring: z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) }),
          },
        },
        async (request) => suggestions.list(userId(request), request.query.page),
      );

      routes.get('/suggestions/count', async (request) => ({
        count: await suggestions.count(userId(request)),
      }));

      const messageParams = z.object({ messageId: z.string().regex(/^[0-9a-f]{64}$/) });
      routes.post(
        '/suggestions/:messageId/decide',
        { schema: { params: messageParams, body: z.object({ path, accept: z.boolean() }) } },
        async (request) =>
          suggestions.decide(
            userId(request),
            request.params.messageId,
            request.body.path,
            request.body.accept,
          ),
      );

      routes.post(
        '/suggestions/:messageId/assign',
        {
          schema: {
            params: messageParams,
            body: z.object({ path, name: z.string().min(1).max(500) }),
          },
        },
        async (request) =>
          suggestions.assign(
            userId(request),
            request.params.messageId,
            request.body.path,
            request.body.name,
          ),
      );
    },
    { prefix: '/ai' },
  );
}
