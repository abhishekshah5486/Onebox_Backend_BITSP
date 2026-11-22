import { lookup } from 'node:dns/promises';
import { ValidationError } from '@onebox/errors';
import ipaddr from 'ipaddr.js';

// Users type base URLs, so the server must not be steered at itself or its private network.
export async function checkEgress(rawUrl: string, allowPrivate: boolean) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('The base URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('The base URL must start with http:// or https://');
  }
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.length === 0) throw new ValidationError(`${url.hostname} could not be found`);
  for (const address of addresses) {
    const parsed = ipaddr.process(address);
    if (parsed.range() !== 'unicast') {
      throw new ValidationError(
        `${url.hostname} is a private or local address, which this server can't call`,
      );
    }
  }
}
