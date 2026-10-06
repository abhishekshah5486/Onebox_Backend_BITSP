import { createTokenVerifier } from '@onebox/auth-kit';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { Redis } from 'ioredis';
import { createRemoteJWKSet } from 'jose';
import { buildGateway } from './app';
import { loadGatewayConfig } from './config';
import { defineUpstreams } from './upstreams';

const logger = createLogger({ service: 'api-gateway', pretty: process.stdout.isTTY });
const config = loadGatewayConfig();

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', (err) => logger.warn({ err }, 'redis error'));

const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', config.AUTH_SERVICE_URL));

const app = await buildGateway({
  logger,
  redis,
  upstreams: defineUpstreams(config),
  verifyToken: createTokenVerifier(jwks),
});
await startServer(app, { port: config.PORT, cleanups: [() => redis.quit()] });
