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

function classify(err: unknown): VerifyFailure {
  const error = err as { authenticationFailed?: boolean; code?: string; message?: string };
  if (error.authenticationFailed) return 'AUTH_FAILED';
  const text = `${error.code ?? ''} ${error.message ?? ''}`;
  if (/CERT|SSL|TLS|self[- ]signed|certificate/i.test(text)) return 'TLS_ERROR';
  return 'UNREACHABLE';
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
      const reason = classify(err);
      logger.warn(
        { host, port, reason, durationMs: Date.now() - startedAt },
        'imap verification failed',
      );
      return { ok: false, reason, message: FAILURE_MESSAGES[reason] };
    } finally {
      client.close();
    }
  };
}
