import { describe, expect, it } from 'vitest';
import { describeFailure } from './verify-imap';

const authError = (responseText: string) => ({ authenticationFailed: true, responseText });

describe('describeFailure', () => {
  it('explains that Google wants an app password', () => {
    const result = describeFailure(
      authError(
        '[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)',
      ),
      'imap.gmail.com',
    );
    expect(result.reason).toBe('AUTH_FAILED');
    expect(result.message).toMatch(/^Gmail requires an app password/);
  });

  it.each([
    ['imap.gmail.com', 'Gmail'],
    ['imap.mail.me.com', 'iCloud'],
    ['imap.mail.yahoo.com', 'Yahoo'],
  ])('hints at app passwords for %s', (host, provider) => {
    expect(describeFailure(authError('Invalid credentials (Failure)'), host).message).toBe(
      `${provider} rejected the sign-in. Use an app password (not your normal password) and check the email address.`,
    );
  });

  it('keeps a generic message for other servers', () => {
    expect(describeFailure(authError('LOGIN failed'), 'mail.corp.example').message).toBe(
      'The mail server rejected the username or password',
    );
  });

  it('classifies certificate and network errors', () => {
    expect(describeFailure({ code: 'CERT_HAS_EXPIRED' }, 'x').reason).toBe('TLS_ERROR');
    expect(describeFailure({ code: 'ECONNREFUSED' }, 'x').reason).toBe('UNREACHABLE');
  });
});
