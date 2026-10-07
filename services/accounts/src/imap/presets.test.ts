import { describe, expect, it } from 'vitest';
import { PRESET_PROVIDERS, PRESETS } from './presets';

describe('provider presets', () => {
  it('uses implicit TLS on port 993 for every IMAP preset', () => {
    for (const provider of PRESET_PROVIDERS) {
      expect(PRESETS[provider].imap, provider).toMatchObject({ port: 993, tls: true });
    }
  });

  it.each([
    ['ICLOUD', 'imap.mail.me.com'],
    ['YAHOO', 'imap.mail.yahoo.com'],
    ['OUTLOOK', 'outlook.office365.com'],
  ] as const)('%s points at %s', (provider, host) => {
    expect(PRESETS[provider].imap.host).toBe(host);
  });
});
