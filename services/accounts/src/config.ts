import { envBoolean, envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4002),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres connection string'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  // Only for local testing against a mail server on this machine (e.g. GreenMail).
  ALLOW_PRIVATE_MAIL_HOSTS: envBoolean.default(false),
});

export type AccountsConfig = z.infer<typeof schema>;

export const loadAccountsConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(schema, env);
