import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-onebox-signature';

export const generateWebhookSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

// Signs "timestamp.body" so receivers can reject replays older than their tolerance window.
export function signWebhook(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) } = {},
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((part) => part.split('=') as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!parts.v1 || !Number.isInteger(timestamp) || Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }
  const expected = Buffer.from(signWebhook(secret, body, timestamp).split('v1=')[1]!, 'hex');
  const actual = Buffer.from(parts.v1, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
