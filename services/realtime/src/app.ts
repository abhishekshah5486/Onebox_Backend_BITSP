import { currentUser, requireUser, type TokenVerifier } from '@onebox/auth-kit';
import { RateLimitedError } from '@onebox/errors';
import { createServer, registerHealthRoutes, type HealthCheck } from '@onebox/http';
import type { Logger } from '@onebox/logger';
import type { Hub } from './hub';

export interface AppDeps {
  logger: Logger;
  checks: Record<string, HealthCheck>;
  hub: Hub;
  verifyToken: TokenVerifier;
  heartbeatMs?: number;
}

// Server-sent events: one long response per open app, carrying that user's live events.
export function buildApp({ logger, checks, hub, verifyToken, heartbeatMs = 20_000 }: AppDeps) {
  const app = createServer({ logger });
  app.decorateRequest('user', null);
  registerHealthRoutes(app, checks);
  const open = new Set<() => void>();

  app.get('/events', { preHandler: requireUser(verifyToken) }, (request, reply) => {
    const { userId } = currentUser(request);
    const raw = reply.raw;
    const send = (data: string) => raw.write(`data: ${data}\n\n`);
    if (!hub.add(userId, send)) {
      throw new RateLimitedError('Too many open live connections', { code: 'TOO_MANY_STREAMS' });
    }
    reply.hijack();
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Stops proxies (e.g. nginx) from holding events back in a buffer.
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 5000\nevent: ready\ndata: {}\n\n');
    // Comments keep idle proxies from closing the stream.
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), heartbeatMs);
    const end = () => {
      clearInterval(heartbeat);
      hub.remove(userId, send);
      open.delete(end);
      raw.end();
    };
    open.add(end);
    request.raw.on('close', end);
    logger.debug({ userId, streams: hub.size }, 'live stream opened');
  });

  // Open streams never finish by themselves, so they're ended before the server closes.
  app.addHook('preClose', (done) => {
    for (const end of [...open]) end();
    done();
  });

  return app;
}
