import { UnauthorizedError } from '@onebox/errors';
import type { TokenVerifier } from '@onebox/auth-kit';
import { createLogger } from '@onebox/logger';
import { startRedis, type TestRedis } from '@onebox/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildGateway } from './app';

const logger = createLogger({ service: 'test', level: 'silent' });

const verifyToken: TokenVerifier = async (token) => {
  if (token !== 'valid')
    throw new UnauthorizedError('Invalid access token', { code: 'INVALID_TOKEN' });
  return { userId: 'u1', email: 'a@onebox.dev' };
};

let redisContainer: TestRedis;
let redis: Redis;
let upstream: FastifyInstance;
let upstreamUrl: string;
let gateway: Awaited<ReturnType<typeof buildGateway>>;

beforeAll(async () => {
  redisContainer = await startRedis();
  redis = new Redis(redisContainer.url, { maxRetriesPerRequest: 1 });

  upstream = Fastify();
  upstream.all('/*', async (request) => ({
    url: request.url,
    requestId: request.headers['x-request-id'],
    authorization: request.headers.authorization ?? null,
  }));
  upstreamUrl = await upstream.listen({ port: 0, host: '127.0.0.1' });

  gateway = await buildGateway({
    logger,
    redis,
    verifyToken,
    globalRateLimit: { max: 50, timeWindow: '1 minute' },
    upstreams: [
      {
        prefix: '/api/v1/auth',
        url: upstreamUrl,
        rewritePrefix: '/auth',
        access: 'public',
        rateLimit: { max: 3, timeWindow: '1 minute' },
      },
      { prefix: '/api/v1/mail', url: upstreamUrl, rewritePrefix: '/mail', access: 'authenticated' },
      { prefix: '/api/v1/down', url: 'http://127.0.0.1:1', rewritePrefix: '/', access: 'public' },
    ],
  });
});

beforeEach(() => redis.flushall());

afterAll(async () => {
  await gateway.close();
  await upstream.close();
  redis.disconnect();
  await redisContainer.stop();
});

describe('api gateway', () => {
  it('proxies with prefix rewrite and forwards the request id', async () => {
    const res = await gateway.inject({
      url: '/api/v1/auth/login?x=1',
      headers: { 'x-request-id': 'req-42' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: '/auth/login?x=1', requestId: 'req-42' });
  });

  it('applies the stricter per-upstream rate limit', async () => {
    const codes = [];
    for (let i = 0; i < 4; i++)
      codes.push((await gateway.inject({ url: '/api/v1/auth/login' })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);

    const limited = await gateway.inject({ url: '/api/v1/auth/login' });
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('rejects protected routes without a valid token before proxying', async () => {
    const missing = await gateway.inject({ url: '/api/v1/mail/threads' });
    const invalid = await gateway.inject({
      url: '/api/v1/mail/threads',
      headers: { authorization: 'Bearer forged' },
    });
    expect(missing.json()).toMatchObject({ error: { code: 'MISSING_TOKEN' } });
    expect(invalid.statusCode).toBe(401);
  });

  it('proxies protected routes with a valid token, keeping the authorization header', async () => {
    const res = await gateway.inject({
      url: '/api/v1/mail/threads',
      headers: { authorization: 'Bearer valid' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: '/mail/threads', authorization: 'Bearer valid' });
  });

  it.each(['/api/v1/auth/../internal/accounts', '/api/v1/auth/%2e%2e/internal/accounts'])(
    'never lets %s escape the upstream prefix',
    async (url) => {
      const res = await gateway.inject({ url });
      const reachedInternal =
        res.statusCode === 200 && res.json<{ url: string }>().url.includes('internal');
      expect(reachedInternal).toBe(false);
    },
  );

  it('returns 503 when an upstream is unreachable', async () => {
    const res = await gateway.inject({ url: '/api/v1/down/x' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
  });

  it('reports readiness from redis and skips rate limits for health checks', async () => {
    for (let i = 0; i < 3; i++) await gateway.inject({ url: '/health/ready' });
    const res = await gateway.inject({ url: '/health/ready' });
    expect(res.json()).toEqual({ status: 'ok', checks: { redis: 'up' } });
  });
});
