import { currentUser } from '@onebox/auth-kit';
import { drivePathSchema } from '@onebox/contracts';
import { AppError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { GoogleService } from './google-service';

const account = z.object({
  id: z.uuid(),
  email: z.string(),
  defaultPath: z.string(),
  connectedAt: z.string(),
  updatedAt: z.string(),
});
const params = z.object({ id: z.uuid() });

export function registerGoogleRoutes(scope: FastifyInstance, google: GoogleService) {
  const routes = scope.withTypeProvider<ZodTypeProvider>();
  const userId = (request: Parameters<typeof currentUser>[0]) => currentUser(request).userId;

  routes.get(
    '/integrations/google',
    {
      schema: {
        response: { 200: z.object({ configured: z.boolean(), accounts: z.array(account) }) },
      },
    },
    async (request) => google.list(userId(request)),
  );

  routes.post(
    '/integrations/google/connect',
    { schema: { response: { 200: z.object({ url: z.string() }) } } },
    async (request) => ({ url: google.authUrl(userId(request)) }),
  );

  routes.patch(
    '/integrations/google/:id',
    {
      schema: {
        params,
        body: z.object({ defaultPath: drivePathSchema }),
        response: { 200: account },
      },
    },
    async (request) =>
      google.setDefaultPath(userId(request), request.params.id, request.body.defaultPath),
  );

  routes.delete('/integrations/google/:id', { schema: { params } }, async (request, reply) => {
    await google.disconnect(userId(request), request.params.id);
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

// Public: Google redirects the browser here, so the signed state identifies the user.
export function registerGoogleCallback(app: HttpServer, google: GoogleService) {
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(
      '/integrations/google/callback',
      { schema: { querystring: callbackQuery } },
      async (request, reply) => {
        const { code, state, error } = request.query;
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

        if (error || !code || !state) {
          return send(
            400,
            'Google Drive was not connected',
            'You can close this window and try again.',
          );
        }
        try {
          const email = await google.complete(code, state);
          return send(
            200,
            'Google Drive connected',
            `${email} is now connected. You can close this window.`,
          );
        } catch (err) {
          const message = err instanceof AppError ? err.message : 'Something went wrong.';
          if (!(err instanceof AppError)) request.log.error({ err }, 'google callback failed');
          return send(400, 'Google Drive was not connected', message);
        }
      },
    );
}
