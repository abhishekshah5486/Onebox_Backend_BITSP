import { z } from 'zod';

// z.coerce.boolean() treats "false" as true, so env flags need explicit parsing.
export const envBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const envPort = z.coerce.number().int().min(1).max(65535);

// Connections each service keeps open. Supabase's session pooler allows 15 clients across every
// service together, so the default stays small.
export const envPoolSize = z.coerce.number().int().min(1).max(50).default(2);
