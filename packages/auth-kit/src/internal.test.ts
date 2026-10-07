import { randomBytes } from 'node:crypto';
import { createServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { describe, expect, it } from 'vitest';
import { deriveInternalToken, INTERNAL_TOKEN_HEADER, requireInternal } from './internal';

describe('internal service auth', () => {
  const key = randomBytes(32);
  const token = deriveInternalToken(key);

  it('derives a stable token that differs from the key', () => {
    expect(deriveInternalToken(key)).toBe(token);
    expect(token).not.toBe(key.toString('base64url'));
    expect(deriveInternalToken(randomBytes(32))).not.toBe(token);
  });

  function app() {
    const server = createServer({ logger: createLogger({ service: 'test', level: 'silent' }) });
    server.get('/internal/ping', { preHandler: requireInternal(token) }, async () => ({
      ok: true,
    }));
    return server;
  }

  it('accepts the derived token', async () => {
    const res = await app().inject({
      url: '/internal/ping',
      headers: { [INTERNAL_TOKEN_HEADER]: token },
    });
    expect(res.json()).toEqual({ ok: true });
  });

  it.each([undefined, 'wrong', `${token}x`])('rejects %j', async (presented) => {
    const res = await app().inject({
      url: '/internal/ping',
      headers: presented ? { [INTERNAL_TOKEN_HEADER]: presented } : {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'INTERNAL_ONLY' } });
  });
});
