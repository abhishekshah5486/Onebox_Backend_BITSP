import { createLogger } from '@onebox/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type HttpServer } from './create-server';
import { registerHealthRoutes } from './health';

let app: HttpServer;
afterEach(() => app.close());

function setup(checks?: Parameters<typeof registerHealthRoutes>[1]) {
  app = createServer({ logger: createLogger({ service: 'test', level: 'silent' }) });
  registerHealthRoutes(app, checks);
  return app;
}

describe('health routes', () => {
  it('reports liveness', async () => {
    const res = await setup().inject({ url: '/health/live' });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('is ready when every check passes', async () => {
    const res = await setup({ postgres: async () => 1, redis: async () => 'PONG' }).inject({
      url: '/health/ready',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', redis: 'up' } });
  });

  it('returns 503 naming the failing dependency', async () => {
    const res = await setup({
      postgres: async () => 1,
      redis: () => Promise.reject(new Error('ECONNREFUSED')),
    }).inject({ url: '/health/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: 'up', redis: 'down' },
    });
  });

  it('treats a hanging check as down', async () => {
    vi.useFakeTimers();
    const pending = setup({ slow: () => new Promise(() => {}) }).inject({ url: '/health/ready' });
    await vi.advanceTimersByTimeAsync(2000);
    const res = await pending;
    vi.useRealTimers();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ checks: { slow: 'down' } });
  });
});
