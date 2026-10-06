import type { GatewayConfig } from './config';

export interface RateLimit {
  max: number;
  timeWindow: string;
}

export interface Upstream {
  prefix: string;
  url: string;
  rewritePrefix: string;
  // authenticated = gateway rejects requests without a valid access token before proxying.
  access: 'public' | 'authenticated';
  rateLimit?: RateLimit;
}

export function defineUpstreams(config: GatewayConfig): Upstream[] {
  return [
    {
      prefix: '/api/v1/auth',
      url: config.AUTH_SERVICE_URL,
      rewritePrefix: '/auth',
      access: 'public',
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  ];
}
