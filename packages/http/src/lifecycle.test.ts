import { createLogger } from '@onebox/logger';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from './create-server';
import { createShutdown } from './lifecycle';

const logger = () => createLogger({ service: 'test', level: 'silent' });

describe('createShutdown', () => {
  it('closes the server, then runs cleanups in order', async () => {
    const app = createServer({ logger: logger() });
    const order: string[] = [];
    app.addHook('onClose', async () => void order.push('server'));

    await createShutdown(app, [
      async () => order.push('redis'),
      async () => order.push('postgres'),
    ])('SIGTERM');

    expect(order).toEqual(['server', 'redis', 'postgres']);
  });

  it('keeps going when a cleanup fails', async () => {
    const app = createServer({ logger: logger() });
    const last = vi.fn(async () => {});

    await createShutdown(app, [() => Promise.reject(new Error('boom')), last])('SIGINT');

    expect(last).toHaveBeenCalledOnce();
  });

  it('runs only once for repeated signals', async () => {
    const app = createServer({ logger: logger() });
    const cleanup = vi.fn(async () => {});
    const shutdown = createShutdown(app, [cleanup]);

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
