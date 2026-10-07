import { hkdfSync, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '@onebox/errors';
import type { preHandlerAsyncHookHandler } from 'fastify';

export const INTERNAL_TOKEN_HEADER = 'x-onebox-internal-token';

// Derived from the shared encryption key, so service-to-service auth needs no extra secret.
export function deriveInternalToken(encryptionKey: Buffer): string {
  return Buffer.from(hkdfSync('sha256', encryptionKey, 'onebox', 'internal-api', 32)).toString(
    'base64url',
  );
}

export function requireInternal(expectedToken: string): preHandlerAsyncHookHandler {
  const expected = Buffer.from(expectedToken);
  return async (request) => {
    const presented = Buffer.from(String(request.headers[INTERNAL_TOKEN_HEADER] ?? ''));
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new UnauthorizedError('Internal endpoint', { code: 'INTERNAL_ONLY' });
    }
  };
}
