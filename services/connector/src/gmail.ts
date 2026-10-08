import { MAIL_CATEGORIES, type MailCategory } from '@onebox/contracts';
import type { ImapFlow } from 'imapflow';

export const isGmail = (client: ImapFlow) => client.capabilities.has('X-GM-EXT-1');

// Gmail's inbox and All Mail carry categories (tabs, Purchases, Travel).
export const hasCategories = (client: ImapFlow, role: string) =>
  (role === 'inbox' || role === 'archive') && isGmail(client);

// Gmail exposes categories only through its own search syntax. Caller holds the folder lock.
export async function readCategories(
  client: ImapFlow,
  scope: { uid: string } | { seq: string } | { all: true },
): Promise<Map<number, MailCategory[]>> {
  const result = new Map<number, MailCategory[]>();
  for (const category of MAIL_CATEGORIES) {
    const uids =
      (await client.search({ ...scope, gmraw: `category:${category}` }, { uid: true })) || [];
    for (const uid of uids) result.set(uid, [...(result.get(uid) ?? []), category]);
  }
  return result;
}
