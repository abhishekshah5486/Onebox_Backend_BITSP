import { currentUser } from '@onebox/auth-kit';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { IndexingStorage } from './indexing-storage';

export function registerIndexingRoutes(scope: FastifyInstance, storage: IndexingStorage) {
  const routes = scope.withTypeProvider<ZodTypeProvider>();
  const userId = (request: Parameters<typeof currentUser>[0]) => currentUser(request).userId;

  routes.get('/indexing-storage', async (request) => storage.get(userId(request)));

  routes.put(
    '/indexing-storage',
    {
      schema: {
        body: z.object({
          url: z.string().min(1).max(500),
          apiKey: z.string().max(2000).optional(),
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
