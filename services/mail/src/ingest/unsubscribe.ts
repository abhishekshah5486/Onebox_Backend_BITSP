export interface Unsubscribe {
  // https link: one-click (RFC 8058) when the sender supports it, otherwise a page to open.
  url: string | null;
  mailto: string | null;
  oneClick: boolean;
  source: 'header' | 'body';
}

interface ListHeader {
  unsubscribe?: { url?: string; mail?: string } | { url?: string; mail?: string }[];
  'unsubscribe-post'?: { name?: string };
}

const MAX_LENGTH = 2048;
const WORDS = /unsubscribe|opt[\s-]?out|email preferences|manage (your )?subscription/i;

function httpUrl(value: string | undefined): string | null {
  if (!value || value.length > MAX_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const decode = (value: string) =>
  value
    .replace(/&amp;/gi, '&')
    .replace(/&#x3d;|&#61;/gi, '=')
    .replace(/&quot;/gi, '"');

// Senders' List-Unsubscribe header first; failing that, an "unsubscribe" link in the body.
export function findUnsubscribe(
  list: unknown,
  html: string | null,
  text: string,
): Unsubscribe | null {
  const header = (list ?? {}) as ListHeader;
  const entries = [header.unsubscribe ?? []].flat();
  const url = entries.map((entry) => httpUrl(entry.url)).find(Boolean) ?? null;
  const mail = entries.map((entry) => entry.mail).find(Boolean);
  if (url || mail) {
    return {
      url,
      mailto: mail && mail.length <= MAX_LENGTH ? `mailto:${mail}` : null,
      oneClick:
        !!url &&
        url.startsWith('https:') &&
        /List-Unsubscribe=One-Click/i.test(header['unsubscribe-post']?.name ?? ''),
      source: 'header',
    };
  }

  if (html) {
    for (const match of html.matchAll(
      /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const href = decode(match[2]!);
      const label = match[3]!.replace(/<[^>]+>/g, ' ');
      const found = httpUrl(href);
      if (found && (WORDS.test(label) || /unsubscribe|optout|opt-out/i.test(href))) {
        return { url: found, mailto: null, oneClick: false, source: 'body' };
      }
    }
  }
  for (const line of text.split('\n')) {
    if (!WORDS.test(line)) continue;
    const found = httpUrl(line.match(/https?:\/\/\S+/)?.[0]?.replace(/[)>\].,]+$/, ''));
    if (found) return { url: found, mailto: null, oneClick: false, source: 'body' };
  }
  return null;
}
