import { UnauthorizedError } from '@onebox/errors';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AuthUser, TokenVerifier } from './verifier';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

export function requireUser(verify: TokenVerifier): preHandlerAsyncHookHandler {
  return async (request) => {
    const token = bearerToken(request);
    if (!token) throw new UnauthorizedError('Missing bearer token', { code: 'MISSING_TOKEN' });
    request.user = await verify(token);
  };
}

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new UnauthorizedError('Not authenticated');
  return request.user;
}
