import { currentUser } from '@onebox/auth-kit';
import { STORAGE_PROVIDERS, storagePathSchema } from '@onebox/contracts';
import { AppError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CALLBACK_SLUGS, PROVIDER_NAMES, type StorageProviderId } from './provider';
import type { StorageService } from './storage-service';

const provider = z.enum(STORAGE_PROVIDERS);
const account = z.object({
  id: z.uuid(),
  provider,
  email: z.string(),
  defaultPath: z.string(),
  connectedAt: z.string(),
  updatedAt: z.string(),
});
const params = z.object({ id: z.uuid() });

export function registerStorageRoutes(scope: FastifyInstance, storage: StorageService) {
  const routes = scope.withTypeProvider<ZodTypeProvider>();
  const userId = (request: Parameters<typeof currentUser>[0]) => currentUser(request).userId;

  routes.get(
    '/storage',
    {
      schema: {
        response: {
          200: z.object({
            providers: z.array(provider),
            accounts: z.array(account),
            failures: z.array(
              z.object({
                provider,
                reason: z.enum(['ACCESS_DENIED', 'FAILED']),
                message: z.string(),
                at: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => storage.list(userId(request)),
  );

  routes.post(
    '/storage/connect',
    {
      schema: {
        body: z.object({ provider }),
        response: { 200: z.object({ url: z.string(), expiresAt: z.string() }) },
      },
    },
    async (request) => storage.authUrl(userId(request), request.body.provider),
  );

  routes.patch(
    '/storage/:id',
    {
      schema: {
        params,
        body: z.object({ defaultPath: storagePathSchema }),
        response: { 200: account },
      },
    },
    async (request) =>
      storage.setDefaultPath(userId(request), request.params.id, request.body.defaultPath),
  );

  routes.delete('/storage/:id', { schema: { params } }, async (request, reply) => {
    await storage.disconnect(userId(request), request.params.id);
    return reply.status(204).send();
  });
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, detail: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>OneBox</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f8f9fa;color:#1f1f1f}
main{text-align:center;max-width:420px;padding:16px}h1{font-size:20px;font-weight:500}p{color:#5f6368}</style>
</head><body><main><h1>${escape(title)}</h1><p>${escape(detail)}</p></main>
<script>setTimeout(() => window.close(), 1500)</script></body></html>`;

const callbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(1024).optional(),
  error: z.string().max(200).optional(),
});

const bySlug = new Map(
  (Object.entries(CALLBACK_SLUGS) as [StorageProviderId, string][]).map(([id, slug]) => [slug, id]),
);

// Public: the provider redirects the browser here, so the signed state identifies the user.
export function registerStorageCallbacks(app: HttpServer, storage: StorageService) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/integrations/:slug/callback',
    {
      schema: {
        params: z.object({ slug: z.string().max(40) }),
        querystring: callbackQuery,
      },
    },
    async (request, reply) => {
      const send = (status: number, title: string, detail: string) =>
        reply
          .status(status)
          .header('content-type', 'text/html; charset=utf-8')
          .header(
            'content-security-policy',
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          )
          .header('cache-control', 'no-store')
          .send(page(title, detail));

      const id = bySlug.get(request.params.slug);
      if (!id) return send(404, 'Not found', 'This sign-in link is not valid.');
      const name = PROVIDER_NAMES[id];
      const { code, state, error } = request.query;
      if (error || !code || !state) {
        if (state) storage.refuse(id, state, error ?? 'missing_code');
        return send(400, `${name} was not connected`, 'You can close this window and try again.');
      }
      try {
        const email = await storage.complete(id, code, state);
        return send(
          200,
          `${name} connected`,
          `${email} is now connected. You can close this window.`,
        );
      } catch (err) {
        const message = err instanceof AppError ? err.message : 'Something went wrong.';
        if (!(err instanceof AppError)) request.log.error({ err }, 'storage callback failed');
        return send(400, `${name} was not connected`, message);
      }
    },
  );
}
