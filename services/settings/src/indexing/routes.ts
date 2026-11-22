import { currentUser } from '@onebox/auth-kit';
import { VECTOR_STORE_IDS } from '@onebox/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { IndexingStorage } from './indexing-storage';

const settingsSchema = z.record(z.string().max(64), z.string().max(4000));
const idParams = z.object({ id: z.string().min(1).max(64) });

export function registerIndexingRoutes(scope: FastifyInstance, storage: IndexingStorage) {
  const routes = scope.withTypeProvider<ZodTypeProvider>();
  const userId = (request: Parameters<typeof currentUser>[0]) => currentUser(request).userId;

  routes.get('/indexing-storage/stores', async () => ({ stores: storage.catalogue() }));

  routes.get('/indexing-storage', async (request) => storage.list(userId(request)));

  routes.post(
    '/indexing-storage',
    {
      schema: {
        body: z.object({
          provider: z.enum(VECTOR_STORE_IDS),
          name: z.string().max(80).optional(),
          settings: settingsSchema,
        }),
      },
    },
    async (request, reply) =>
      reply.code(201).send(await storage.add(userId(request), request.body)),
  );

  routes.patch(
    '/indexing-storage/:id',
    {
      schema: {
        params: idParams,
        body: z.object({
          name: z.string().max(80).optional(),
          settings: settingsSchema.optional(),
          paused: z.boolean().optional(),
        }),
      },
    },
    async (request) => storage.update(userId(request), request.params.id, request.body),
  );

  routes.put(
    '/indexing-storage/search',
    { schema: { body: z.object({ storeId: z.string().min(1).max(64) }) } },
    async (request) => storage.useForSearch(userId(request), request.body.storeId),
  );

  routes.delete(
    '/indexing-storage/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await storage.remove(userId(request), request.params.id);
      return reply.code(204).send();
    },
  );
}
