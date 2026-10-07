import { requireInternal } from '@onebox/auth-kit';
import type { HttpServer } from '@onebox/http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AccountService } from './account-service';

const params = z.object({ id: z.uuid() });

// Never routed by the gateway; only other services holding the internal token can call these.
export function registerInternalRoutes(
  app: HttpServer,
  accounts: AccountService,
  internalToken: string,
) {
  void app.register(
    async (scope) => {
      const routes = scope.withTypeProvider<ZodTypeProvider>();
      routes.addHook('preHandler', requireInternal(internalToken));

      routes.get('/accounts', async () => ({ items: await accounts.listActive() }));

      routes.get('/accounts/:id/credentials', { schema: { params } }, async (request) =>
        accounts.getCredentials(request.params.id),
      );

      routes.put(
        '/accounts/:id/sync-state',
        {
          schema: {
            params,
            body: z.object({
              folder: z
                .string()
                .min(1)
                .max(200)
                .regex(/^[^{},]+$/, 'invalid folder name'),
              state: z.record(z.string(), z.unknown()),
            }),
          },
        },
        async (request, reply) => {
          await accounts.saveSyncState(request.params.id, request.body.folder, request.body.state);
          return reply.status(204).send();
        },
      );

      routes.put(
        '/accounts/:id/status',
        {
          schema: {
            params,
            body: z.object({
              status: z.enum(['CONNECTED', 'AUTH_FAILED', 'UNREACHABLE', 'TLS_ERROR']),
              lastError: z.string().max(500).nullable(),
            }),
          },
        },
        async (request, reply) => {
          await accounts.reportStatus(
            request.params.id,
            request.body.status,
            request.body.lastError,
          );
          return reply.status(204).send();
        },
      );
    },
    { prefix: '/internal' },
  );
}
