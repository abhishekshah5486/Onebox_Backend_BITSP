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

  it('protects every other upstream', () => {
    const others = upstreams.filter((u) => u.prefix !== '/api/v1/auth');
    expect(others.map((u) => u.prefix)).toEqual(['/api/v1/accounts', '/api/v1/settings']);
    expect(others.every((u) => u.access === 'authenticated')).toBe(true);
  });

  it('uses unique prefixes', () => {
    expect(new Set(upstreams.map((u) => u.prefix)).size).toBe(upstreams.length);
  });
});
