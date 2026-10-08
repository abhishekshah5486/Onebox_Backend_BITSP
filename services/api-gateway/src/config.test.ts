import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from './config';

describe('loadGatewayConfig', () => {
  it('defaults the port and auth service url', () => {
    expect(loadGatewayConfig({ REDIS_URL: 'redis://localhost:6379' })).toEqual({
      PORT: 4000,
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SERVICE_URL: 'http://localhost:4001',
      ACCOUNTS_SERVICE_URL: 'http://localhost:4002',
      SETTINGS_SERVICE_URL: 'http://localhost:4004',
      MAIL_SERVICE_URL: 'http://localhost:4003',
      LLM_PROXY_SERVICE_URL: 'http://localhost:4006',
      AI_SERVICE_URL: 'http://localhost:4007',
    });
  });

  it('requires a redis url', () => {
    expect(() => loadGatewayConfig({})).toThrow(/REDIS_URL/);
  });
});
