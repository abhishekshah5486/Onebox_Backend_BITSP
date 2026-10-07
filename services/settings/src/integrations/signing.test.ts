import { describe, expect, it } from 'vitest';
import { generateWebhookSecret, signWebhook, verifyWebhookSignature } from './signing';

describe('webhook signing', () => {
  const secret = generateWebhookSecret();
  const body = '{"type":"integration.test"}';

  it('generates prefixed high-entropy secrets', () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(secret);
  });

  it('produces a signature receivers can verify', () => {
    const header = signWebhook(secret, body, 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, body, header, { now: 1_700_000_010 })).toBe(true);
  });

  it.each([
    ['a tampered body', (h: string) => [h, '{"type":"other"}']],
    ['another secret', (h: string) => [h, body, generateWebhookSecret()]],
    ['an old timestamp', (h: string) => [h, body, secret, 1_700_001_000]],
    ['a malformed header', () => ['garbage', body]],
  ] as const)('rejects %s', (_label, mutate) => {
    const [header, payload, key = secret, now = 1_700_000_010] = mutate(
      signWebhook(secret, body, 1_700_000_000),
    ) as [string, string, string?, number?];
    expect(verifyWebhookSignature(key, payload, header, { now })).toBe(false);
  });
});
