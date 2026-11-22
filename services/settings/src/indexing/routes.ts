import { currentUser } from '@onebox/auth-kit';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { VECTOR_STORE_IDS } from '@onebox/contracts';
import { z } from 'zod';
import type { IndexingStorage } from './indexing-storage';

export function registerIndexingRoutes(scope: FastifyInstance, storage: IndexingStorage) {
  const routes = scope.withTypeProvider<ZodTypeProvider>();
  const userId = (request: Parameters<typeof currentUser>[0]) => currentUser(request).userId;

  routes.get('/indexing-storage/stores', async () => ({ stores: storage.stores() }));

  routes.get('/indexing-storage', async (request) => storage.get(userId(request)));

  routes.put(
    '/indexing-storage',
    {
      schema: {
        body: z.object({
          provider: z.enum(VECTOR_STORE_IDS),
          settings: z.record(z.string().max(64), z.string().max(4000)),
        }),
      },
    },
    async (request) => storage.set(userId(request), request.body),
  );

  routes.delete('/indexing-storage', async (request, reply) => {
    await storage.clear(userId(request));
    return reply.code(204).send();
  });
}
