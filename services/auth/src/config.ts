import { envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres connection string'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  PORT: envPort.default(4001),
});

export type AuthConfig = z.infer<typeof schema>;

export const loadAuthConfig = (env?: Record<string, string | undefined>) => loadConfig(schema, env);
