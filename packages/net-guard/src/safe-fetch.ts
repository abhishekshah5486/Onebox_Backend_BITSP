import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch, type RequestInit } from 'undici';
import { isPrivateAddress } from './net-guard';

export class SafeFetchError extends Error {
  constructor(
    readonly code: 'BLOCKED_HOST' | 'TIMEOUT' | 'NETWORK' | 'INVALID_URL',
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

// Checked inside the connection itself, so a DNS answer cannot change between check and connect.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0);
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      return callback(
        new SafeFetchError('BLOCKED_HOST', `${hostname} resolves to a private network`),
        '',
        0,
      );
    }
    if (options.all)
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

const agents = {
  guarded: new Agent({ connect: { lookup: guardedLookup } }),
  open: new Agent(),
};

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowPrivate?: boolean;
  maxBodyBytes?: number;
}

export interface SafeFetchResponse {
  status: number;
  ok: boolean;
  body: string;
}

export async function safeFetch(
  target: string,
  { timeoutMs = 5000, allowPrivate = false, maxBodyBytes = 4096, ...init }: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new SafeFetchError('INVALID_URL', 'Invalid URL');
  }
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(literal) && isPrivateAddress(literal)) {
    throw new SafeFetchError('BLOCKED_HOST', `${literal} is a private address`);
  }

  try {
    const response = await fetch(url, {
      ...(init as RequestInit),
      // Redirects are never followed: they could point at an internal host.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: allowPrivate ? agents.open : agents.guarded,
    });
    const body = (await response.text()).slice(0, maxBodyBytes);
    return { status: response.status, ok: response.status >= 200 && response.status < 300, body };
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof SafeFetchError) throw cause;
    if ((err as Error).name === 'TimeoutError') {
      throw new SafeFetchError('TIMEOUT', `Timed out after ${timeoutMs}ms`);
    }
    throw new SafeFetchError(
      'NETWORK',
      (cause as Error | undefined)?.message ?? (err as Error).message,
    );
  }
}
