import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { vectorStoreSetupSchema, type VectorStoreSetup } from '@onebox/contracts';

// Every store the user keeps vectors in, with the keys to reach them.
export async function fetchSetup(
  baseUrl: string,
  internalToken: string,
  userId: string,
): Promise<VectorStoreSetup> {
  const response = await fetch(`${baseUrl}/internal/indexing-storage/${userId}`, {
    headers: { [INTERNAL_TOKEN_HEADER]: internalToken },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`settings answered ${response.status}`);
  return vectorStoreSetupSchema.parse(await response.json());
}
