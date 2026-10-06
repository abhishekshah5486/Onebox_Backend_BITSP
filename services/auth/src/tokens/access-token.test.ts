import { createTokenVerifier } from '@onebox/auth-kit';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, issueAccessToken } from './access-token';

describe('issueAccessToken', () => {
  it('issues a 15 minute token the shared verifier accepts', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA');
    const jwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA' }],
    });

    const token = await issueAccessToken({ kid: 'k1', privateKey }, { id: 'u1', email: 'a@b.co' });
    const claims = decodeJwt(token);

    expect(claims.exp! - claims.iat!).toBe(ACCESS_TOKEN_TTL_SECONDS);
    await expect(createTokenVerifier(jwks)(token)).resolves.toEqual({
      userId: 'u1',
      email: 'a@b.co',
    });
  });
});
