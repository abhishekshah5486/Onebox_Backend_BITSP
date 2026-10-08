import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 10 * 60_000;

// Signed OAuth state, so the public callback knows which user started the flow.
export function createStateSigner(encryptionKey: Buffer, now = () => Date.now()) {
  const key = Buffer.from(hkdfSync('sha256', encryptionKey, 'onebox', 'google-oauth-state', 32));
  const mac = (body: string) => createHmac('sha256', key).update(body).digest('base64url');

  return {
    sign(userId: string) {
      const body = Buffer.from(
        JSON.stringify({ u: userId, e: now() + TTL_MS, n: randomBytes(8).toString('hex') }),
      ).toString('base64url');
      return `${body}.${mac(body)}`;
    },

    // The user id, or null for a forged or expired state.
    verify(state: string): string | null {
      const [body, signature] = state.split('.');
      if (!body || !signature) return null;
      const expected = Buffer.from(mac(body));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const { u, e } = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
          u: string;
          e: number;
        };
        return typeof u === 'string' && e > now() ? u : null;
      } catch {
        return null;
      }
    },
  };
}
