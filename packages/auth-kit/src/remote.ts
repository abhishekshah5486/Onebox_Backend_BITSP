import { createRemoteJWKSet } from 'jose';
import { createTokenVerifier, type TokenVerifier } from './verifier';

// Keys are cached and refetched at most every 30s when an unknown kid appears (key rotation).
export function createRemoteTokenVerifier(authServiceUrl: string): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', authServiceUrl), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5000,
  });
  return createTokenVerifier(jwks);
}
