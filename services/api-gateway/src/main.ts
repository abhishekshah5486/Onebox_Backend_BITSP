import { createRemoteTokenVerifier } from '@onebox/auth-kit';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { Redis } from 'ioredis';
import { buildGateway } from './app';
import { loadGatewayConfig } from './config';
import { defineUpstreams } from './upstreams';

const logger = createLogger({ service: 'api-gateway', pretty: process.stdout.isTTY });
const config = loadGatewayConfig();

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', (err) => logger.warn({ err }, 'redis error'));

const app = await buildGateway({
  logger,
  redis,
  upstreams: defineUpstreams(config),
  verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
});
await startServer(app, { port: config.PORT, cleanups: [() => redis.quit()] });
