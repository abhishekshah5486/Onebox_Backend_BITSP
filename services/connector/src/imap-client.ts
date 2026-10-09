import { resolvePublicHost } from '@onebox/net-guard';
import { ImapFlow } from 'imapflow';
import type { InternalClient } from './internal-client';

export const FOLDER = 'INBOX';

export class AuthenticationFailedError extends Error {
  constructor(readonly serverResponse: string | undefined) {
    super('Mailbox rejected the stored credentials');
    this.name = 'AuthenticationFailedError';
  }
}

export interface OpenClientOptions {
  internal: InternalClient;
  allowPrivateHosts: boolean;
  connectTimeoutMs?: number;
  // Live sessions IDLE almost immediately (imapflow waits 15s by default); short-lived ones never do.
  idle?: 'fast' | 'off';
}

// Connects to the vetted IP (SSRF-safe) while still verifying TLS against the real hostname.
export async function openImapClient(accountId: string, options: OpenClientOptions) {
  const credentials = await options.internal.getCredentials(accountId);
  const resolved = await resolvePublicHost(credentials.host, {
    allowPrivate: options.allowPrivateHosts,
  });
  const timeoutMs = options.connectTimeoutMs ?? 30_000;

  const client = new ImapFlow({
    host: resolved.address,
    port: credentials.port,
    secure: credentials.tls,
    servername: credentials.host,
    tls: { servername: credentials.host, rejectUnauthorized: true },
    auth: { user: credentials.username, pass: credentials.password },
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    ...(options.idle === 'off' ? { disableAutoIdle: true } : { autoIdleDelay: 1000 }),
  });

  // Without a listener an 'error' event (e.g. a socket reset) would crash the whole connector;
  // sessions add their own listener to react, and the failure also surfaces through the
  // pending call.
  client.on('error', () => {});

  try {
    await client.connect();
  } catch (err) {
    const error = err as { authenticationFailed?: boolean; responseText?: string };
    if (error.authenticationFailed) throw new AuthenticationFailedError(error.responseText);
    throw err;
  }
  return client;
}
