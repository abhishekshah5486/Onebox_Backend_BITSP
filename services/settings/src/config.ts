import { envBoolean, envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4004),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres connection string'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  // Only for local testing against webhook receivers on this machine.
  ALLOW_PRIVATE_WEBHOOK_HOSTS: envBoolean.default(false),
  // Google Drive stays off until an OAuth client is configured.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.url().default('http://localhost:4000/api/v1/integrations/google/callback'),
});

export type SettingsConfig = z.infer<typeof schema>;

export const loadSettingsConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(schema, env);
