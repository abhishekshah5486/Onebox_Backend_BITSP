import { TOKEN_AUDIENCE, TOKEN_ISSUER } from '@onebox/auth-kit';
import { SignJWT } from 'jose';
import { SIGNING_ALG, type SigningKey } from '../keys/key-store';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export async function issueAccessToken(
  key: SigningKey,
  user: { id: string; email: string },
  now: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: SIGNING_ALG, kid: key.kid })
    .setSubject(user.id)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
    .sign(key.privateKey);
}
