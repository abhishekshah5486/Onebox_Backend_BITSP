import proxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import type { TokenVerifier } from '@onebox/auth-kit';
import { bearerToken } from '@onebox/auth-kit';
import { RateLimitedError, ServiceUnavailableError, UnauthorizedError } from '@onebox/errors';
import { createServer, registerHealthRoutes } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { Redis } from 'ioredis';
import type { RateLimit, Upstream } from './upstreams';

export interface GatewayDeps {
  logger: Logger;
  redis: Redis;
  upstreams: Upstream[];
  verifyToken: TokenVerifier;
  globalRateLimit?: RateLimit;
}

export async function buildGateway({
  logger,
  redis,
  upstreams,
  verifyToken,
  globalRateLimit = { max: 300, timeWindow: '1 minute' },
}: GatewayDeps) {
  const app = createServer({ logger });
  app.decorateRequest('user', null);
  registerHealthRoutes(app, { redis: () => redis.ping() });

  await app.register(rateLimit, {
    ...globalRateLimit,
    redis,
    nameSpace: 'rl:gateway:',
    // Fail open: a Redis outage should degrade protection, not take the API down.
    skipOnError: true,
    allowList: (request) => request.url.startsWith('/health/'),
    errorResponseBuilder: (_request, context) =>
      new RateLimitedError(`Too many requests, retry in ${context.after}`),
  });

  for (const upstream of upstreams) {
    await app.register(proxy, {
      upstream: upstream.url,
      prefix: upstream.prefix,
      rewritePrefix: upstream.rewritePrefix,
      config: upstream.rateLimit ? { rateLimit: upstream.rateLimit } : {},
      ...(upstream.access === 'authenticated' && {
        preHandler: (request, _reply, done) => {
          const token = bearerToken(request);
          if (!token) {
            done(new UnauthorizedError('Missing bearer token', { code: 'MISSING_TOKEN' }));
            return;
          }
          verifyToken(token).then((user) => {
            request.user = user;
            done();
          }, done);
        },
      }),
      replyOptions: {
        rewriteRequestHeaders: (request, headers) => ({ ...headers, 'x-request-id': request.id }),
        onError: (reply, { error }) => {
          const timedOut = (error as { statusCode?: number }).statusCode === 504;
          void reply.send(
            timedOut
              ? error
              : new ServiceUnavailableError('Upstream service unavailable', {
                  code: 'UPSTREAM_UNAVAILABLE',
                }),
          );
        },
      },
    });
    logger.info({ prefix: upstream.prefix, url: upstream.url }, 'upstream registered');
  }

  return app;
}
