export interface Authentication {
  // Domain that passed SPF (Gmail's "mailed-by").
  mailedBy: string | null;
  // Domain whose DKIM signature passed (Gmail's "signed-by").
  signedBy: string | null;
  // Whether the last hop into the mailbox used TLS; null when the server does not say.
  encrypted: boolean | null;
}

const first = (value: unknown): string | null => {
  const top: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (typeof top === 'string') return top;
  if (top && typeof top === 'object' && 'value' in top) return String(top.value);
  return null;
};

const domain = (value: string | undefined) =>
  value
    ?.replace(/^.*@/, '')
    .replace(/[>;,\s].*$/, '')
    .toLowerCase() || null;

// Only the topmost Authentication-Results and Received headers are trusted: those are added by
// the user's own provider, while anything further down could have been written by the sender.
export function readAuthentication(headers: Map<string, unknown>): Authentication {
  const results = first(headers.get('authentication-results')) ?? '';
  const dkim = results.match(/\bdkim=pass\b[^;]*?\bheader\.(?:i|d)=@?([^\s;]+)/i);
  const spf = results.match(/\bspf=pass\b[^;]*?\bsmtp\.mailfrom=([^\s;]+)/i);
  const received = first(headers.get('received'));
  return {
    mailedBy: domain(spf?.[1]),
    signedBy: domain(dkim?.[1]),
    encrypted: received === null ? null : /\bwith\s+E?SMTPSA?\b|\bTLS/i.test(received),
  };
}
