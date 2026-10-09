import { UnauthorizedError } from '@onebox/errors';
import { createServer } from '@onebox/http';
import { createLogger } from '@onebox/logger';
import { describe, expect, it } from 'vitest';
import { currentUser, requireUser } from './fastify';
import type { TokenVerifier } from './verifier';

const verify: TokenVerifier = async (token) => {
  if (token !== 'good')
    throw new UnauthorizedError('Invalid access token', { code: 'INVALID_TOKEN' });
  return { userId: 'u1', email: 'a@onebox.dev' };
};

function setup() {
  const app = createServer({ logger: createLogger({ service: 'test', level: 'silent' }) });
  app.decorateRequest('user', null);
  app.get('/me', { preHandler: requireUser(verify) }, async (request) => currentUser(request));
  return app;
}

describe('requireUser', () => {
  it('attaches the user for a valid bearer token', async () => {
    const res = await setup().inject({ url: '/me', headers: { authorization: 'Bearer good' } });
    expect(res.json()).toEqual({ userId: 'u1', email: 'a@onebox.dev' });
  });

  it.each([
    [undefined, 'MISSING_TOKEN'],
    ['Basic good', 'MISSING_TOKEN'],
    ['Bearer', 'MISSING_TOKEN'],
    ['Bearer bad', 'INVALID_TOKEN'],
  ])('rejects authorization %j with %s', async (authorization, code) => {
    const res = await setup().inject({
      url: '/me',
      headers: authorization ? { authorization } : {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code } });
  });
});
