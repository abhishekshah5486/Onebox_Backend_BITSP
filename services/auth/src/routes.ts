import { currentUser, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import type { HttpServer } from '@onebox/http';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeyStore } from './keys/key-store';
import { passwordSchema } from './passwords';
import type { UserService } from './users/user-service';

export interface AuthRouteDeps {
  users: UserService;
  keyStore: KeyStore;
  verifyToken: TokenVerifier;
}

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const refreshBody = z.object({ refreshToken: z.string().min(1).max(512) });

const clientMeta = (request: FastifyRequest) => ({
  userAgent: request.headers['user-agent'],
  ip: request.ip,
});

export function registerAuthRoutes(
  app: HttpServer,
  { users, keyStore, verifyToken }: AuthRouteDeps,
) {
  app.decorateRequest('user', null);

  app.get('/.well-known/jwks.json', async (_request, reply) => {
    void reply.header('cache-control', 'public, max-age=300');
    return keyStore.getPublicJwks();
  });

  app.post(
    '/auth/register',
    {
      schema: {
        body: z.object({
          email,
          name: z.string().trim().min(1).max(100),
          password: passwordSchema,
        }),
      },
    },
    async (request, reply) =>
      reply.status(201).send(await users.register(request.body, clientMeta(request))),
  );

  app.post(
    '/auth/login',
    { schema: { body: z.object({ email, password: z.string().min(1).max(128) }) } },
    async (request) => users.login(request.body, clientMeta(request)),
  );

  app.post('/auth/refresh', { schema: { body: refreshBody } }, async (request) =>
    users.refresh(request.body.refreshToken, clientMeta(request)),
  );

  app.post('/auth/logout', { schema: { body: refreshBody } }, async (request, reply) => {
    await users.logout(request.body.refreshToken);
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: requireUser(verifyToken) }, async (request) =>
    users.getProfile(currentUser(request).userId),
  );
}
