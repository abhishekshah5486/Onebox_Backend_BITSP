import type { ImapFlow } from 'imapflow';
import { describe, expect, it, vi } from 'vitest';
import { readCategories, setGmailLabels } from './gmail';

describe('readCategories', () => {
  it('names the UIDs of a sequence range, since Gmail ignores X-GM-RAW with one', async () => {
    const search = vi.fn(async (query: Record<string, string>) => {
      if (query.seq) return [101, 102];
      if (query.gmraw === 'category:updates') return query.uid === '101,102' ? [102] : [];
      return [];
    });
    const client = { search } as unknown as ImapFlow;

    const tags = await readCategories(client, { seq: '5:6' });

    expect(search).toHaveBeenCalledWith({ seq: '5:6' }, { uid: true });
    const categorySearches = search.mock.calls.slice(1).map(([query]) => query);
    expect(categorySearches.every((query) => query.uid === '101,102' && !query.seq)).toBe(true);
    expect([...tags]).toEqual([[102, ['updates']]]);
  });

  it('skips the category searches for an empty range', async () => {
    const search = vi.fn(async () => []);
    expect((await readCategories({ search } as unknown as ImapFlow, { seq: '9:9' })).size).toBe(0);
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('setGmailLabels', () => {
  const fake = (capabilities: string[]) => ({
    capabilities: new Set(capabilities),
    messageFlagsAdd: vi.fn(async () => true),
    messageFlagsRemove: vi.fn(async () => true),
  });

  it('sets labels through X-GM-LABELS on Gmail', async () => {
    const client = fake(['IMAP4rev1', 'X-GM-EXT-1']);
    const done = await setGmailLabels(client as unknown as ImapFlow, '4,9', {
      add: ['Leads'],
      remove: ['Old'],
    });
    expect(done).toBe(true);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('4,9', ['Leads'], {
      uid: true,
      useLabels: true,
    });
    expect(client.messageFlagsRemove).toHaveBeenCalledWith('4,9', ['Old'], {
      uid: true,
      useLabels: true,
    });
  });

  it('leaves other servers alone', async () => {
    const client = fake(['IMAP4rev1']);
    expect(
      await setGmailLabels(client as unknown as ImapFlow, '4', { add: ['Leads'], remove: [] }),
    ).toBe(false);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
});
