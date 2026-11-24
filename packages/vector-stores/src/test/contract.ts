import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VectorStoreId } from '@onebox/contracts';
import { checkVectorStore, openVectorStore, type VectorStore } from '../index';

const A = '0b4f7f62-6f36-4d84-9d0b-6f1f6a3d6d01';
const B = '0b4f7f62-6f36-4d84-9d0b-6f1f6a3d6d02';
const C = '0b4f7f62-6f36-4d84-9d0b-6f1f6a3d6d03';
const D = '0b4f7f62-6f36-4d84-9d0b-6f1f6a3d6d04';
const me = 'user-1111';
const other = 'user-2222';

// Some stores index in the background; reads are retried until they settle.
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// What every store must do for semantic search, run against the real database.
export function storeContract(
  provider: Exclude<VectorStoreId, 'QDRANT'>,
  start: () => Promise<{ settings: Record<string, string>; stop: () => Promise<void> }>,
  {
    badSettings,
  }: { badSettings?: (settings: Record<string, string>) => Record<string, string> } = {},
) {
  describe(`${provider} store`, () => {
    let server: Awaited<ReturnType<typeof start>>;
    let store: VectorStore;

    beforeAll(async () => {
      server = await start();
      // Some report healthy a little before they take queries.
      await eventually(
        () =>
          checkVectorStore(provider, server.settings).then(
            () => true,
            () => false,
          ),
        (ready) => ready,
        120_000,
      );
      store = openVectorStore(provider, server.settings);
    }, 300_000);

    afterAll(async () => {
      await store?.close();
      await server?.stop();
    });

    it('checks its credentials', async () => {
      await checkVectorStore(provider, server.settings);
      if (badSettings) {
        await expect(
          checkVectorStore(provider, badSettings(server.settings)),
        ).rejects.toMatchObject({
          name: 'StoreCheckError',
        });
      }
    }, 60_000);

    it('keeps, finds, replaces and forgets vectors for one user at a time', async () => {
      const collection = store.collection('mail_test-model_3', 3);
      await collection.ensure();
      await collection.ensure();
      expect(await store.collections()).toContain(collection.name);

      await collection.upsert(me, [
        { id: A, vector: [1, 0, 0], payload: { threadId: 'a', n: 1 } },
        { id: B, vector: [0, 1, 0], payload: { threadId: 'b', n: 2 } },
        { id: C, vector: [0.9, 0.1, 0], payload: { threadId: 'c', n: 3 } },
      ]);
      await collection.upsert(other, [{ id: D, vector: [1, 0, 0], payload: { threadId: 'd' } }]);

      const [got] = await collection.get(me, [A], true);
      expect(got?.payload).toEqual({ threadId: 'a', n: 1 });
      expect(got?.vector?.map((x) => Math.round(x * 100) / 100)).toEqual([1, 0, 0]);
      expect((await collection.get(me, [A], false))[0]?.payload).toEqual({ threadId: 'a', n: 1 });

      const hits = await eventually(
        () => collection.query(me, [1, 0, 0], 10),
        (found) => found.length === 3,
      );
      expect(hits.map((hit) => hit.id)).toEqual([A, C, B]);
      expect(hits[0]!.score).toBeGreaterThan(0.99);
      expect(hits[2]!.score).toBeLessThan(0.1);

      await collection.upsert(me, [{ id: A, vector: [1, 0, 0], payload: { threadId: 'a', n: 9 } }]);
      expect((await collection.get(me, [A], false))[0]?.payload).toEqual({ threadId: 'a', n: 9 });

      await collection.delete(me, [B]);
      expect(await collection.get(me, [B], false)).toEqual([]);

      await collection.deleteUser(me);
      const left = await eventually(
        () => collection.query(me, [1, 0, 0], 10),
        (found) => found.length === 0,
      );
      expect(left).toEqual([]);
      const theirs = await eventually(
        () => collection.query(other, [1, 0, 0], 10),
        (found) => found.length === 1,
      );
      expect(theirs.map((hit) => hit.id)).toEqual([D]);
    }, 240_000);
  });
}
