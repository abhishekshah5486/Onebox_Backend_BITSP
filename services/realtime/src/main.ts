import { createRemoteTokenVerifier } from '@onebox/auth-kit';
import { LIVE_CHANNEL_PATTERN, liveEventSchema } from '@onebox/contracts';
import { startServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { loadRealtimeConfig } from './config';
import { createHub } from './hub';

const logger = createLogger({ service: 'realtime', pretty: process.stdout.isTTY });
const config = loadRealtimeConfig();

const hub = createHub();
// A subscribed connection can do nothing else, so health checks use their own.
const subscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
for (const connection of [subscriber, redis]) {
  connection.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
}

await subscriber.psubscribe(LIVE_CHANNEL_PATTERN);
subscriber.on('pmessage', (_pattern, channel, message) => {
  const userId = channel.slice(channel.indexOf(':') + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    parsed = null;
  }
  if (!liveEventSchema.safeParse(parsed).success) {
    logger.warn({ channel }, 'malformed live event dropped');
    return;
  }
  hub.deliver(userId, message);
});
logger.info('listening for live events');

const app = buildApp({
  logger,
  checks: { redis: () => redis.ping() },
  hub,
  verifyToken: createRemoteTokenVerifier(config.AUTH_SERVICE_URL),
});
await startServer(app, {
  port: config.PORT,
  cleanups: [() => subscriber.quit(), () => redis.quit()],
});
