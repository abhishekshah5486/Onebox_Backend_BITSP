import { envPort, loadConfig } from '@onebox/config';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4000),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
});

export type GatewayConfig = z.infer<typeof schema>;

export const loadGatewayConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(schema, env);
