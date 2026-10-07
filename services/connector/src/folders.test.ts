import { describe, expect, it } from 'vitest';
import { discoverFolders } from './folders';

const folder = (
  path: string,
  extra: { specialUse?: string; specialUseSource?: 'extension' | 'name'; flags?: string[] } = {},
) => ({
  path,
  name: path.split('/').at(-1)!,
  flags: new Set(extra.flags ?? []),
  specialUse: extra.specialUse,
  specialUseSource: extra.specialUseSource,
});

describe('discoverFolders', () => {
  it('maps gmail special-use folders to roles', () => {
    expect(
      discoverFolders([
        folder('INBOX'),
        folder('[Gmail]', { flags: ['\\Noselect'] }),
        folder('[Gmail]/All Mail', { specialUse: '\\All', specialUseSource: 'extension' }),
        folder('[Gmail]/Sent Mail', { specialUse: '\\Sent', specialUseSource: 'extension' }),
        folder('[Gmail]/Drafts', { specialUse: '\\Drafts', specialUseSource: 'extension' }),
        folder('[Gmail]/Spam', { specialUse: '\\Junk', specialUseSource: 'extension' }),
        folder('[Gmail]/Bin', { specialUse: '\\Trash', specialUseSource: 'extension' }),
      ]),
    ).toEqual([
      { path: '[Gmail]/Sent Mail', role: 'sent' },
      { path: '[Gmail]/Drafts', role: 'drafts' },
      { path: '[Gmail]/Spam', role: 'spam' },
      { path: '[Gmail]/Bin', role: 'trash' },
    ]);
  });

  it('falls back to common folder names when the server declares nothing', () => {
    expect(
      discoverFolders([folder('Sent Items'), folder('Bulk'), folder('Deleted Items')]),
    ).toEqual([
      { path: 'Sent Items', role: 'sent' },
      { path: 'Bulk', role: 'spam' },
      { path: 'Deleted Items', role: 'trash' },
    ]);
  });

  it('prefers a declared folder over one that only has a matching name', () => {
    expect(
      discoverFolders([
        folder('Sent'),
        folder('Archive/Sent', { specialUse: '\\Sent', specialUseSource: 'extension' }),
      ]),
    ).toEqual([{ path: 'Archive/Sent', role: 'sent' }]);
  });

  it('skips folders that cannot be opened', () => {
    expect(discoverFolders([folder('Trash', { flags: ['\\Noselect'] })])).toEqual([]);
  });
});
