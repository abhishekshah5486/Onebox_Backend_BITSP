import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from './config';
import { defineUpstreams } from './upstreams';

describe('defineUpstreams', () => {
  const upstreams = defineUpstreams(loadGatewayConfig({ REDIS_URL: 'redis://localhost:6379' }));

  it('keeps auth public with a strict rate limit', () => {
    expect(upstreams.find((u) => u.prefix === '/api/v1/auth')).toMatchObject({
      access: 'public',
      rateLimit: { max: 20 },
    });
  });

  it('keeps only OAuth callbacks and payment webhooks public besides auth', () => {
    expect(upstreams.find((u) => u.prefix === '/api/v1/integrations')).toMatchObject({
      access: 'public',
      rewritePrefix: '/integrations',
    });
    expect(upstreams.find((u) => u.prefix === '/api/v1/webhooks')).toMatchObject({
      access: 'public',
      rewritePrefix: '/webhooks',
    });
  });

  it('protects every other upstream', () => {
    const publicPrefixes = ['/api/v1/auth', '/api/v1/integrations', '/api/v1/webhooks'];
    const others = upstreams.filter((u) => !publicPrefixes.includes(u.prefix));
    expect(others.map((u) => u.prefix)).toEqual([
      '/api/v1/accounts',
      '/api/v1/settings',
      '/api/v1/payments',
      '/api/v1/mail',
      '/api/v1/llm',
      '/api/v1/ai',
    ]);
    expect(others.every((u) => u.access === 'authenticated')).toBe(true);
  });

  it('uses unique prefixes', () => {
    expect(new Set(upstreams.map((u) => u.prefix)).size).toBe(upstreams.length);
  });
});
