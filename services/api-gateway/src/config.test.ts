import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from './config';

describe('loadGatewayConfig', () => {
  it('defaults the port and auth service url', () => {
    expect(loadGatewayConfig({ REDIS_URL: 'redis://localhost:6379' })).toEqual({
      GATEWAY_PORT: 4000,
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SERVICE_URL: 'http://localhost:4001',
    });
  });

  it('requires a redis url', () => {
    expect(() => loadGatewayConfig({})).toThrow(/REDIS_URL/);
  });
});
