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
    {
      prefix: '/api/v1/accounts',
      url: config.ACCOUNTS_SERVICE_URL,
      rewritePrefix: '/accounts',
      access: 'authenticated',
    },
    {
      prefix: '/api/v1/settings',
      url: config.SETTINGS_SERVICE_URL,
      rewritePrefix: '/settings',
      access: 'authenticated',
    },
    {
      // Only the Google OAuth callback lives here; the signed state identifies the user.
      prefix: '/api/v1/integrations',
      url: config.SETTINGS_SERVICE_URL,
      rewritePrefix: '/integrations',
      access: 'public',
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
    {
      prefix: '/api/v1/mail',
      url: config.MAIL_SERVICE_URL,
      rewritePrefix: '/mail',
      access: 'authenticated',
    },
    // Model choice and usage only; completions are internal and never routed here.
    {
      prefix: '/api/v1/llm',
      url: config.LLM_PROXY_SERVICE_URL,
      rewritePrefix: '/llm',
      access: 'authenticated',
    },
    {
      prefix: '/api/v1/ai',
      url: config.AI_SERVICE_URL,
      rewritePrefix: '/ai',
      access: 'authenticated',
    },
  ];
}
