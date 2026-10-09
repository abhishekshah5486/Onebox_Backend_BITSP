import cookie from '@fastify/cookie';
import { currentUser, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { UnauthorizedError } from '@onebox/errors';
import type { HttpServer } from '@onebox/http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeyStore } from './keys/key-store';
import { REFRESH_TOKEN_TTL_MS } from './tokens/refresh-tokens';
import { passwordSchema } from './passwords';
import type { UserService } from './users/user-service';

export interface AuthRouteDeps {
  users: UserService;
  keyStore: KeyStore;
  verifyToken: TokenVerifier;
}

export const REFRESH_COOKIE = 'ob_refresh';
// Browser path of the auth routes behind the gateway; the cookie is only sent there.
const COOKIE_PATH = '/api/v1/auth';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
// Browsers send no body at all and rely on the cookie.
const refreshBody = z.object({ refreshToken: z.string().min(1).max(512).optional() }).nullish();

type Session = Awaited<ReturnType<UserService['login']>>;

const isWebClient = (request: FastifyRequest) => request.headers['x-onebox-client'] === 'web';

// Web clients get the refresh token as an HttpOnly cookie so page scripts can never read it.
function sendSession(request: FastifyRequest, reply: FastifyReply, session: Session) {
  if (!isWebClient(request)) return session;
  const { refreshToken, ...tokens } = session.tokens;
  void reply.setCookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_MS / 1000,
  });
  return { ...session, tokens };
}

function presentedRefreshToken(
  request: FastifyRequest,
  body: { refreshToken?: string | undefined } | null | undefined,
) {
  const token = body?.refreshToken ?? request.cookies[REFRESH_COOKIE];
  if (!token)
    throw new UnauthorizedError('Missing refresh token', { code: 'MISSING_REFRESH_TOKEN' });
  return token;
}

const clientMeta = (request: FastifyRequest) => ({
  userAgent: request.headers['user-agent'],
  ip: request.ip,
});

export function registerAuthRoutes(
  app: HttpServer,
  { users, keyStore, verifyToken }: AuthRouteDeps,
) {
  app.decorateRequest('user', null);
  void app.register(cookie);

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
    async (request, reply) => {
      const session = await users.register(request.body, clientMeta(request));
      return reply.status(201).send(sendSession(request, reply, session));
    },
  );

  app.post(
    '/auth/login',
    { schema: { body: z.object({ email, password: z.string().min(1).max(128) }) } },
    async (request, reply) =>
      sendSession(request, reply, await users.login(request.body, clientMeta(request))),
  );

  app.post('/auth/refresh', { schema: { body: refreshBody } }, async (request, reply) => {
    const token = presentedRefreshToken(request, request.body);
    return sendSession(request, reply, await users.refresh(token, clientMeta(request)));
  });

  app.post('/auth/logout', { schema: { body: refreshBody } }, async (request, reply) => {
    const token = request.body?.refreshToken ?? request.cookies[REFRESH_COOKIE];
    if (token) await users.logout(token);
    return reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH }).status(204).send();
  });

  app.get('/auth/me', { preHandler: requireUser(verifyToken) }, async (request) =>
    users.getProfile(currentUser(request).userId),
  );
}
