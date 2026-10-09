import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// Every provider's sign-in link is valid this long.
export const STATE_TTL_MS = 10 * 60_000;

// Signed OAuth state, so a public callback knows who started the flow (e.g. "GOOGLE_DRIVE:<userId>").
export function createStateSigner(encryptionKey: Buffer, now = () => Date.now()) {
  const key = Buffer.from(hkdfSync('sha256', encryptionKey, 'onebox', 'oauth-state', 32));
  const mac = (body: string) => createHmac('sha256', key).update(body).digest('base64url');

  return {
    sign(subject: string) {
      const body = Buffer.from(
        JSON.stringify({ u: subject, e: now() + STATE_TTL_MS, n: randomBytes(8).toString('hex') }),
      ).toString('base64url');
      return `${body}.${mac(body)}`;
    },

    // The subject, or null for a forged or expired state.
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
