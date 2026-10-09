import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ValidationError } from '@onebox/errors';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return blocked.check(mapped, 'ipv4');
  const family = isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export type Lookup = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface ResolvedHost {
  host: string;
  address: string;
}

// Rejects hosts that resolve to internal networks (SSRF). Callers should connect to the
// returned address, not re-resolve the name, so DNS rebinding cannot swap it afterwards.
export async function resolvePublicHost(
  host: string,
  {
    lookup = defaultLookup,
    allowPrivate = false,
  }: { lookup?: Lookup; allowPrivate?: boolean } = {},
): Promise<ResolvedHost> {
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host)).map((entry) => entry.address);
  } catch {
    throw new ValidationError(`Host ${host} could not be resolved`, { code: 'HOST_NOT_FOUND' });
  }
  if (addresses.length === 0) {
    throw new ValidationError(`Host ${host} could not be resolved`, { code: 'HOST_NOT_FOUND' });
  }
  if (!allowPrivate && addresses.some(isPrivateAddress)) {
    throw new ValidationError(`Host ${host} points to a private network`, {
      code: 'HOST_NOT_ALLOWED',
    });
  }
  return { host, address: addresses[0]! };
}
