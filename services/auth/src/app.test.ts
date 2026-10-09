import { createLogger } from '@onebox/logger';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

const logger = createLogger({ service: 'auth', level: 'silent' });

describe('auth app', () => {
  it('is ready when postgres answers', async () => {
    const app = buildApp({ logger, pingDatabase: async () => {} });
    const res = await app.inject({ url: '/health/ready' });
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'up' } });
  });

  it('is not ready when postgres is down', async () => {
    const app = buildApp({ logger, pingDatabase: () => Promise.reject(new Error('down')) });
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(503);
  });
});
