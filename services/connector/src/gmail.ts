import type { GmailCategory } from '@onebox/contracts';
import type { ImapFlow } from 'imapflow';

export const isGmail = (client: ImapFlow) => client.capabilities.has('X-GM-EXT-1');

// Primary is whatever is in none of the others.
const TABS = ['social', 'promotions', 'updates', 'forums'] as const;

// Gmail exposes inbox tabs only through its own search syntax. Caller holds the INBOX lock.
export async function readCategories(
  client: ImapFlow,
  scope: { uid: string } | { seq: string } | { all: true },
): Promise<Map<number, GmailCategory>> {
  const result = new Map<number, GmailCategory>();
  for (const tab of TABS) {
    const uids = (await client.search({ ...scope, gmraw: `category:${tab}` }, { uid: true })) || [];
    for (const uid of uids) if (!result.has(uid)) result.set(uid, tab);
  }
  return result;
}
