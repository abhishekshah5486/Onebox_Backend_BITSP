import { UnauthorizedError } from '@onebox/errors';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier, TOKEN_AUDIENCE, TOKEN_ISSUER, type TokenVerifier } from './verifier';

let privateKey: CryptoKey;
let verify: TokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'EdDSA' };
  verify = createTokenVerifier(createLocalJWKSet({ keys: [jwk] }));
});

function sign(
  claims: Record<string, unknown> = {},
  { exp, aud = TOKEN_AUDIENCE }: { exp?: string | number; aud?: string } = {},
) {
  return new SignJWT({ email: 'a@onebox.dev', ...claims })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
    .setSubject('user-1')
    .setIssuer(TOKEN_ISSUER)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp ?? '15m')
    .sign(privateKey);
}

describe('createTokenVerifier', () => {
  it('returns the user for a valid token', async () => {
    await expect(verify(await sign())).resolves.toEqual({
      userId: 'user-1',
      email: 'a@onebox.dev',
    });
  });

  it('flags expired tokens distinctly', async () => {
    const token = await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(verify(token)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', statusCode: 401 });
  });

  it('rejects the wrong audience', async () => {
    await expect(verify(await sign({}, { aud: 'other' }))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('rejects tokens signed by another key', async () => {
    const other = await generateKeyPair('EdDSA');
    const token = await new SignJWT({ email: 'a@onebox.dev' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setSubject('user-1')
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime('15m')
      .sign(other.privateKey);
    await expect(verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects garbage', async () => {
    await expect(verify('not.a.jwt')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects tokens without an email claim', async () => {
    await expect(verify(await sign({ email: undefined }))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});
