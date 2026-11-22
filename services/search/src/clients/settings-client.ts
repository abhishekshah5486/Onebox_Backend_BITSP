import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { z } from 'zod';
import type { StoreConnection } from '../semantic/models';

const storeSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('ONEBOX') }),
  z.object({ provider: z.literal('QDRANT'), url: z.url(), apiKey: z.string().nullable() }),
]);

// Where the user keeps their vectors, with the key to reach them.
export async function fetchStore(
  baseUrl: string,
  internalToken: string,
  userId: string,
): Promise<StoreConnection> {
  const response = await fetch(`${baseUrl}/internal/indexing-storage/${userId}`, {
    headers: { [INTERNAL_TOKEN_HEADER]: internalToken },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`settings answered ${response.status}`);
  return storeSchema.parse(await response.json());
}
