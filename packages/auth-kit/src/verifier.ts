import { UnauthorizedError } from '@onebox/errors';
import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const TOKEN_ISSUER = 'onebox-auth';
export const TOKEN_AUDIENCE = 'onebox';

export interface AuthUser {
  userId: string;
  email: string;
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

export function createTokenVerifier(jwks: JWTVerifyGetKey): TokenVerifier {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        algorithms: ['EdDSA'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        throw new UnauthorizedError('Invalid access token');
      }
      return { userId: payload.sub, email: payload.email };
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      const expired = err instanceof errors.JWTExpired;
      throw new UnauthorizedError(expired ? 'Access token expired' : 'Invalid access token', {
        code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      });
    }
  };
}
