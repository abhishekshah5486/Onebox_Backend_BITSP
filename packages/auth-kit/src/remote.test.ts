import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemoteTokenVerifier } from './remote';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from './verifier';

let server: Server;
let url: string;
let token: string;
let jwksRequests = 0;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA' };
  server = createServer((req, res) => {
    jwksRequests += 1;
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/.well-known/jwks.json' ? JSON.stringify({ keys: [jwk] }) : '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = await new SignJWT({ email: 'a@onebox.dev' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
    .setSubject('u1')
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setExpirationTime('5m')
    .sign(privateKey);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('createRemoteTokenVerifier', () => {
  it('verifies tokens against the auth service jwks and caches the keys', async () => {
    const verify = createRemoteTokenVerifier(url);
    await expect(verify(token)).resolves.toEqual({ userId: 'u1', email: 'a@onebox.dev' });
    await verify(token);
    expect(jwksRequests).toBe(1);
  });
});
