import { ValidationError } from '@onebox/errors';
import { resolvePublicHost } from '@onebox/net-guard';

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
  if (!allowPrivate) await resolvePublicHost(url.hostname.replace(/^\[|\]$/g, ''));
}
