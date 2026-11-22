import { currentUser, requireInternal, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { NotFoundError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MODEL_KINDS, PROVIDERS, PURPOSES } from '../db/schema';
import { AUTO, type Catalog } from './catalog';
import type { Completer } from './complete';
import type { Embeddings } from './embed';
import type { ProviderDirectory } from '../byok/directory';
import type { UserModels } from '../byok/user-models';
import type { EmbeddingCatalog } from './embedding-catalog';
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

const embedBody = z.object({
  userId: z.uuid(),
  texts: z.array(z.string().min(1).max(32_000)).min(1).max(64),
  charge: z.boolean(),
  model: z.string().min(1).max(200).optional(),
});

const settingsSchema = z.record(z.string().max(50), z.string().max(20_000));
const userModelBody = z.object({
  kind: z.enum(MODEL_KINDS),
  providerId: z.string().min(1).max(100),
  modelId: z.string().trim().min(1).max(200),
  name: z.string().max(100).optional(),
  settings: settingsSchema,
  contextTokens: z.number().int().positive().max(100_000_000).optional(),
  reasoning: z.boolean().optional(),
  multimodal: z.boolean().optional(),
});

export function registerLlmRoutes(
  app: HttpServer,
  deps: {
    catalog: Catalog;
    complete: Completer;
    embed: Embeddings;
    embeddingCatalog: EmbeddingCatalog;
    // Tells search to embed the user's mail again with their new model.
    reembed: (userId: string, modelId: string) => Promise<void>;
    usage: Usage;
    // Providers users can bring their own keys for.
    directory: ProviderDirectory;
    userModels: UserModels;
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
    )
    .post(
      '/internal/embed',
      { preHandler: requireInternal(deps.internalToken), schema: { body: embedBody } },
      async (request) => deps.embed(request.body),
    )
    .get(
      '/internal/embed/model',
      {
        preHandler: requireInternal(deps.internalToken),
        schema: { querystring: z.object({ userId: z.uuid().optional() }) },
      },
      async (request) => deps.embed.modelFor(request.query.userId),
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
                    prices: z.object({
                      input: z.number(),
                      output: z.number(),
                      cacheRead: z.number(),
                      cacheWrite: z.number(),
                    }),
                  }),
                ),
                purposes: z.array(z.enum(PURPOSES)),
                choices: z.record(z.string(), z.string()),
              }),
            },
          },
        },
        async (request) => {
          const [items, choices] = await Promise.all([
            catalog.list(),
            catalog.choices(userId(request)),
          ]);
          return { items, purposes: [...PURPOSES], choices };
        },
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

      // The models semantic search can embed with, and the user's pick.
      // Cards for the provider grid; the models come with one provider, on opening it.
      routes.get('/providers', async () => ({
        items: (await deps.directory.providers()).map(({ models, ...provider }) => ({
          ...provider,
          modelCount: models.length,
          embeddings: models.some((model) => model.embedding),
        })),
      }));

      routes.get(
        '/providers/:id',
        { schema: { params: z.object({ id: z.string().min(1).max(100) }) } },
        async (request) => {
          const provider = await deps.directory.provider(request.params.id);
          if (!provider) throw new NotFoundError('No such provider');
          return provider;
        },
      );

      // Models found with the credentials typed so far, to fill the model picker.
      routes.post(
        '/providers/:id/models',
        {
          schema: {
            params: z.object({ id: z.string().min(1).max(100) }),
            body: z.object({ settings: settingsSchema }),
          },
        },
        async (request) => ({
          items: await deps.userModels.discover(request.params.id, request.body.settings),
        }),
      );

      routes.get(
        '/user-models',
        { schema: { querystring: z.object({ kind: z.enum(MODEL_KINDS).optional() }) } },
        async (request) => ({
          items: await deps.userModels.list(userId(request), request.query.kind),
        }),
      );

      routes.post('/user-models', { schema: { body: userModelBody } }, async (request, reply) =>
        reply.code(201).send(await deps.userModels.add(userId(request), request.body)),
      );

      routes.patch(
        '/user-models/:id',
        {
          schema: {
            params: z.object({ id: z.uuid() }),
            body: userModelBody.omit({ kind: true, providerId: true }).partial(),
          },
        },
        async (request) => deps.userModels.update(userId(request), request.params.id, request.body),
      );

      routes.delete(
        '/user-models/:id',
        { schema: { params: z.object({ id: z.uuid() }) } },
        async (request, reply) => {
          await deps.userModels.remove(userId(request), request.params.id);
          return reply.code(204).send();
        },
      );

      routes.get('/embeddings', async (request) => {
        const [items, chosen] = await Promise.all([
          deps.embeddingCatalog.list(),
          deps.embeddingCatalog.choiceOf(userId(request)),
        ]);
        return { items, chosen, default: deps.embeddingCatalog.defaultModel };
      });

      routes.put(
        '/embeddings/choice',
        { schema: { body: z.object({ modelId: z.string().min(1).max(200) }) } },
        async (request) => {
          const user = userId(request);
          const before = await deps.embeddingCatalog.choiceOf(user);
          const model = await deps.embeddingCatalog.choose(user, request.body.modelId);
          if (model.id !== before) await deps.reembed(user, model.id);
          return { chosen: model.id };
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
