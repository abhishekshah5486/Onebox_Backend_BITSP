import type { FolderRole, MailboxLabel } from '@onebox/contracts';
import type { ListResponse } from 'imapflow';
import type { FolderRef } from './ingest-jobs';

export type SecondaryRole = Exclude<FolderRole, 'inbox'>;

// Archive is last so a provider's real Archive folder wins over a name match on another role.
const SPECIAL_USE: Record<string, SecondaryRole> = {
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Junk': 'spam',
  '\\Trash': 'trash',
  '\\Archive': 'archive',
  '\\All': 'archive',
};

const NAMES: Record<SecondaryRole, string[]> = {
  sent: ['sent', 'sent mail', 'sent items', 'sent messages'],
  drafts: ['drafts', 'draft'],
  spam: ['spam', 'junk', 'junk mail', 'junk e-mail', 'junk email', 'bulk', 'bulk mail'],
  trash: ['trash', 'bin', 'deleted', 'deleted items', 'deleted messages'],
  archive: ['archive', 'archives', 'all mail'],
};

// Labels beyond this are not synced; each one costs a folder visit every sync.
export const MAX_LABELS = 50;

type Listed = Pick<
  ListResponse,
  'path' | 'name' | 'flags' | 'specialUse' | 'specialUseSource' | 'delimiter'
>;

export interface DiscoveredFolders {
  folders: FolderRef[];
  labels: (FolderRef & MailboxLabel)[];
}

// Server-declared special-use wins over imapflow's name guess, which wins over our name list.
function rank(entry: Listed, role: SecondaryRole): number {
  if (entry.specialUse && SPECIAL_USE[entry.specialUse] === role) {
    return entry.specialUseSource === 'name' ? 2 : 3;
  }
  return NAMES[role].includes(entry.name.trim().toLowerCase()) ? 1 : 0;
}

const isInbox = (entry: Listed) => entry.path.toUpperCase() === 'INBOX';

// Gmail's own views (Important, Starred, Chats) sit under [Gmail] and are not labels.
const isSystem = (entry: Listed) =>
  /^\[(Gmail|Google Mail)\]/.test(entry.path) ||
  entry.specialUse !== undefined ||
  entry.flags.has('\\Important');

export function discoverFolders(entries: Listed[]): DiscoveredFolders {
  const selectable = entries.filter(
    (entry) => !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'),
  );
  const folders: FolderRef[] = [];
  for (const role of Object.keys(NAMES) as SecondaryRole[]) {
    let best: Listed | undefined;
    for (const entry of selectable) {
      if (folders.some((found) => found.path === entry.path)) continue;
      const score = rank(entry, role);
      if (score > 0 && (!best || score > rank(best, role))) best = entry;
    }
    if (best && !isInbox(best)) folders.push({ path: best.path, role });
  }

  const taken = new Set(folders.map((folder) => folder.path));
  const labels = selectable
    .filter((entry) => !isInbox(entry) && !isSystem(entry) && !taken.has(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_LABELS)
    .map((entry) => ({
      path: entry.path,
      role: 'label' as const,
      name: entry.delimiter ? entry.path.split(entry.delimiter).join('/') : entry.path,
    }));
  return { folders, labels };
}
