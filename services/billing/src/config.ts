import { envPort, loadConfig } from '@onebox/config';
import { encryptionKeySchema } from '@onebox/crypto';
import { z } from 'zod';

const schema = z.object({
  PORT: envPort.default(4009),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres connection string'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis url'),
  CREDENTIALS_ENCRYPTION_KEY: encryptionKeySchema,
  AUTH_SERVICE_URL: z.url().default('http://localhost:4001'),
  // A credit is worth ₹1 (plans sell about that), and AI calls are charged at a markup on what
  // the model cost: credits = cost in USD × USD_TO_INR × CREDIT_MARKUP.
  USD_TO_INR: z.coerce.number().positive().default(85),
  CREDIT_MARKUP: z.coerce.number().positive().default(2),
});

export type BillingConfig = z.infer<typeof schema>;

export const loadBillingConfig = (env?: Record<string, string | undefined>) =>
  loadConfig(schema, env);
