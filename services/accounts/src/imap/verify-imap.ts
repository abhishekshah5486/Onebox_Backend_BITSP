import type { Logger } from '@onebox/logger';
import { resolvePublicHost, type Lookup } from '@onebox/net-guard';
import { ImapFlow } from 'imapflow';

export interface ImapCredentials {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
}

export type VerifyFailure = 'AUTH_FAILED' | 'UNREACHABLE' | 'TLS_ERROR';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure; message: string };

export type ImapVerifier = (credentials: ImapCredentials) => Promise<VerifyResult>;

export interface ImapVerifierOptions {
  logger: Logger;
  allowPrivateHosts?: boolean;
  lookup?: Lookup;
  timeoutMs?: number;
}

const FAILURE_MESSAGES: Record<VerifyFailure, string> = {
  AUTH_FAILED: 'The mail server rejected the username or password',
  UNREACHABLE: 'Could not connect to the mail server',
  TLS_ERROR: 'The mail server certificate could not be verified',
};

// These providers refuse the account's normal password for IMAP and need an app password.
const APP_PASSWORD_HOSTS: Record<string, string> = {
  'imap.gmail.com': 'Gmail',
  'imap.mail.me.com': 'iCloud',
  'imap.mail.yahoo.com': 'Yahoo',
};

interface ImapError {
  authenticationFailed?: boolean;
  code?: string;
  message?: string;
  responseText?: string;
}

export function describeFailure(
  err: unknown,
  host: string,
): { reason: VerifyFailure; message: string } {
  const error = err as ImapError;
  if (error.authenticationFailed) {
    const provider = APP_PASSWORD_HOSTS[host];
    if (/application-specific password/i.test(error.responseText ?? '')) {
      return {
        reason: 'AUTH_FAILED',
        message: `${provider ?? 'This provider'} requires an app password for mail apps. Create one and use it instead of your normal password.`,
      };
    }
    return {
      reason: 'AUTH_FAILED',
      message: provider
        ? `${provider} rejected the sign-in. Use an app password (not your normal password) and check the email address.`
        : FAILURE_MESSAGES.AUTH_FAILED,
    };
  }
  const text = `${error.code ?? ''} ${error.message ?? ''}`;
  const reason: VerifyFailure = /CERT|SSL|TLS|self[- ]signed|certificate/i.test(text)
    ? 'TLS_ERROR'
    : 'UNREACHABLE';
  return { reason, message: FAILURE_MESSAGES[reason] };
}

export function createImapVerifier({
  logger,
  allowPrivateHosts = false,
  lookup,
  timeoutMs = 15_000,
}: ImapVerifierOptions): ImapVerifier {
  return async ({ host, port, tls, username, password }) => {
    // Throws a 400 for private or unresolvable hosts before any connection is attempted.
    const resolved = await resolvePublicHost(host, {
      allowPrivate: allowPrivateHosts,
      ...(lookup && { lookup }),
    });

    const client = new ImapFlow({
      host: resolved.address,
      port,
      secure: tls,
      servername: host,
      tls: { servername: host, rejectUnauthorized: true },
      auth: { user: username, pass: password },
      logger: false,
      verifyOnly: true,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
    client.on('error', () => {});

    const startedAt = Date.now();
    try {
      await client.connect();
      logger.info(
        { host, port, durationMs: Date.now() - startedAt },
        'imap verification succeeded',
      );
      return { ok: true };
    } catch (err) {
      const { reason, message } = describeFailure(err, host);
      // The server's reply never contains the password and is the key to diagnosing failures.
      const serverResponse = (err as ImapError).responseText?.slice(0, 200);
      logger.warn(
        { host, port, reason, serverResponse, durationMs: Date.now() - startedAt },
        'imap verification failed',
      );
      return { ok: false, reason, message };
    } finally {
      client.close();
    }
  };
}
