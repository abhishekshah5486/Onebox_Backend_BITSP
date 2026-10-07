import type { FolderRole } from '@onebox/contracts';
import type { ListResponse } from 'imapflow';
import type { FolderRef } from './ingest-jobs';

export type SecondaryRole = Exclude<FolderRole, 'inbox'>;

const SPECIAL_USE: Record<string, SecondaryRole> = {
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Junk': 'spam',
  '\\Trash': 'trash',
};

const NAMES: Record<SecondaryRole, string[]> = {
  sent: ['sent', 'sent mail', 'sent items', 'sent messages'],
  drafts: ['drafts', 'draft'],
  spam: ['spam', 'junk', 'junk mail', 'junk e-mail', 'junk email', 'bulk', 'bulk mail'],
  trash: ['trash', 'bin', 'deleted', 'deleted items', 'deleted messages'],
};

type Listed = Pick<ListResponse, 'path' | 'name' | 'flags' | 'specialUse' | 'specialUseSource'>;

// Server-declared special-use wins over imapflow's name guess, which wins over our name list.
function rank(entry: Listed, role: SecondaryRole): number {
  if (entry.specialUse && SPECIAL_USE[entry.specialUse] === role) {
    return entry.specialUseSource === 'name' ? 2 : 3;
  }
  return NAMES[role].includes(entry.name.trim().toLowerCase()) ? 1 : 0;
}

export function discoverFolders(entries: Listed[]): FolderRef[] {
  const selectable = entries.filter(
    (entry) => !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'),
  );
  const found: FolderRef[] = [];
  for (const role of Object.keys(NAMES) as SecondaryRole[]) {
    let best: Listed | undefined;
    for (const entry of selectable) {
      const score = rank(entry, role);
      if (score > 0 && (!best || score > rank(best, role))) best = entry;
    }
    if (best && best.path.toUpperCase() !== 'INBOX') found.push({ path: best.path, role });
  }
  return found;
}
