import { describe, expect, it } from 'vitest';
import { discoverFolders, MAX_LABELS } from './folders';

const folder = (
  path: string,
  extra: { specialUse?: string; specialUseSource?: 'extension' | 'name'; flags?: string[] } = {},
) => ({
  path,
  name: path.split('/').at(-1)!,
  delimiter: '/',
  flags: new Set(extra.flags ?? []),
  specialUse: extra.specialUse,
  specialUseSource: extra.specialUseSource,
});

describe('discoverFolders', () => {
  it('maps gmail special-use folders to roles and keeps labels apart', () => {
    expect(
      discoverFolders([
        folder('INBOX'),
        folder('Work'),
        folder('Work/Clients'),
        folder('[Gmail]', { flags: ['\\Noselect'] }),
        folder('[Gmail]/All Mail', { specialUse: '\\All', specialUseSource: 'extension' }),
        folder('[Gmail]/Important', { flags: ['\\Important'] }),
        folder('[Gmail]/Starred', { specialUse: '\\Flagged', specialUseSource: 'extension' }),
        folder('[Gmail]/Sent Mail', { specialUse: '\\Sent', specialUseSource: 'extension' }),
        folder('[Gmail]/Drafts', { specialUse: '\\Drafts', specialUseSource: 'extension' }),
        folder('[Gmail]/Spam', { specialUse: '\\Junk', specialUseSource: 'extension' }),
        folder('[Gmail]/Bin', { specialUse: '\\Trash', specialUseSource: 'extension' }),
      ]),
    ).toEqual({
      folders: [
        { path: '[Gmail]/Sent Mail', role: 'sent' },
        { path: '[Gmail]/Drafts', role: 'drafts' },
        { path: '[Gmail]/Spam', role: 'spam' },
        { path: '[Gmail]/Bin', role: 'trash' },
        { path: '[Gmail]/All Mail', role: 'archive' },
      ],
      labels: [
        { path: 'Work', role: 'label', name: 'Work' },
        { path: 'Work/Clients', role: 'label', name: 'Work/Clients' },
      ],
    });
  });

  it('falls back to common folder names when the server declares nothing', () => {
    expect(
      discoverFolders([
        folder('Sent Items'),
        folder('Bulk'),
        folder('Deleted Items'),
        folder('Archive'),
        folder('Receipts'),
      ]),
    ).toEqual({
      folders: [
        { path: 'Sent Items', role: 'sent' },
        { path: 'Bulk', role: 'spam' },
        { path: 'Deleted Items', role: 'trash' },
        { path: 'Archive', role: 'archive' },
      ],
      labels: [{ path: 'Receipts', role: 'label', name: 'Receipts' }],
    });
  });

  it('prefers a declared folder and leaves a name-only match as a label', () => {
    expect(
      discoverFolders([
        folder('Sent'),
        folder('Archive/Sent', { specialUse: '\\Sent', specialUseSource: 'extension' }),
      ]),
    ).toEqual({
      folders: [{ path: 'Archive/Sent', role: 'sent' }],
      labels: [{ path: 'Sent', role: 'label', name: 'Sent' }],
    });
  });

  it('skips folders that cannot be opened', () => {
    expect(discoverFolders([folder('Trash', { flags: ['\\Noselect'] })])).toEqual({
      folders: [],
      labels: [],
    });
  });

  it('caps how many labels are synced', () => {
    const many = Array.from({ length: MAX_LABELS + 5 }, (_, i) => folder(`L${100 + i}`));
    expect(discoverFolders(many).labels).toHaveLength(MAX_LABELS);
  });
});
