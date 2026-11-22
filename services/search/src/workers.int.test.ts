import { createJobEnvelope, type IndexPayload, type SearchDocument } from '@onebox/contracts';
import { startRedis, type TestRedis } from '@onebox/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIndexState, labelsOf, type IndexState } from './index-state';
import { copy, searchDoc } from './test-doc';
import { indexHandler, vectorHandler } from './workers';
import type { SemanticModels } from './semantic/models';

let redisServer: TestRedis;
let redis: Redis;
let state: IndexState;

// An index that keeps the latest version of each email, like the real ones do.
function memoryIndex() {
  const docs = new Map<string, { doc: SearchDocument; version: number }>();
  return {
    docs,
    name: 'memory',
    upsert: vi.fn(async (doc: SearchDocument, version: number) => {
      const held = docs.get(doc.key);
      if (held && held.version > version) return false;
      docs.set(doc.key, { doc, version });
      return true;
    }),
    removeCopy: vi.fn(async (key: string, messageId: string, version: number) => {
      const held = docs.get(key);
      if (!held || held.version > version) return false;
      const copies = held.doc.copies.filter((c) => c.messageId !== messageId);
      if (copies.length === 0) docs.delete(key);
      else docs.set(key, { doc: { ...held.doc, copies }, version });
      return copies.length === 0;
    }),
  };
}

let n = 0;
const job = (payload: IndexPayload) =>
  createJobEnvelope({ jobId: `j${(n += 1)}`, userId: 'u1', payload });
const upsert = (doc: SearchDocument, version: number) => job({ op: 'upsert', version, doc });
const remove = (messageId: string, version: number) => job({ op: 'delete', version, messageId });

beforeAll(async () => {
  redisServer = await startRedis();
  redis = new Redis(redisServer.url);
  state = createIndexState(redis);
}, 120_000);

beforeEach(async () => {
  await redis.flushall();
});

afterAll(async () => {
  await redis?.quit();
  await redisServer?.stop();
});

describe('index workers', () => {
  const both = searchDoc({ key: 'k1', copies: [copy('m1'), copy('m1-all', 'archive')] });

  it('keeps one document per email as copies come and go', async () => {
    const index = memoryIndex();
    const handle = indexHandler(index, state);
    await handle(upsert(searchDoc({ key: 'k1', copies: [copy('m1')] }), 1));
    await handle(upsert(both, 2));
    expect(index.docs.size).toBe(1);

    await handle(remove('m1', 3));
    expect(index.docs.get('k1')!.doc.copies.map((c) => c.messageId)).toEqual(['m1-all']);
    await handle(remove('m1-all', 4));
    expect(index.docs.size).toBe(0);
  });

  it('never brings back a copy removed before its older write landed', async () => {
    const index = memoryIndex();
    const handle = indexHandler(index, state);
    await handle(upsert(searchDoc({ key: 'k1', copies: [copy('m1-all', 'archive')] }), 1));
    // The removal of m1 is handled first; the write that still lists it arrives late.
    await handle(remove('m1', 3));
    await handle(upsert(both, 2));
    expect(index.docs.get('k1')!.doc.copies.map((c) => c.messageId)).toEqual(['m1-all']);

    await handle(remove('m1-all', 5));
    await handle(upsert(searchDoc({ key: 'k1', copies: [copy('m1-all', 'archive')] }), 4));
    expect(index.docs.size).toBe(0);
  });

  it('lets a copy re-added later in through', async () => {
    const index = memoryIndex();
    const handle = indexHandler(index, state);
    await handle(upsert(both, 1));
    await handle(remove('m1', 2));
    await handle(upsert(both, 3));
    expect(index.docs.get('k1')!.doc.copies).toHaveLength(2);
  });

  it('handles one email at a time, so the second job retries', async () => {
    let release!: () => void;
    const index = memoryIndex();
    const gate = new Promise<void>((resolve) => (release = resolve));
    index.upsert.mockImplementationOnce(async (doc, version) => {
      await gate;
      index.docs.set(doc.key, { doc, version });
      return true;
    });
    const handle = indexHandler(index, state);
    const first = handle(upsert(both, 1));
    await vi.waitFor(() => expect(index.upsert).toHaveBeenCalled());
    await expect(handle(remove('m1', 2))).rejects.toMatchObject({ code: 'INDEX_BUSY' });
    release();
    await first;
    await handle(remove('m1', 2));
    expect(index.docs.get('k1')!.doc.copies).toHaveLength(1);
  });

  it('embeds with each model the user needs, without charging them', async () => {
    const embed = vi.fn(async () => [[1]]);
    const vector = () => ({
      upsert: vi.fn(async (_doc: SearchDocument, _v: number, run: (t: string[]) => unknown) => {
        await run(['text']);
        return 'embedded' as const;
      }),
      removeCopy: vi.fn(async () => true),
    });
    const indexes = { a: vector(), b: vector() };
    const models = {
      // Mid-switch: searching with a, moving to b.
      targets: vi.fn(async () => [
        { model: { id: 'a' }, index: indexes.a },
        { model: { id: 'b' }, index: indexes.b },
      ]),
      allIndexes: vi.fn(async () => [indexes.a, indexes.b]),
    };
    const handle = vectorHandler(models as unknown as SemanticModels, embed, state);
    await handle(upsert(both, 1));
    expect(embed.mock.calls).toEqual([
      [{ userId: 'u1', texts: ['text'], charge: false, model: 'a' }],
      [{ userId: 'u1', texts: ['text'], charge: false, model: 'b' }],
    ]);

    await handle(remove('m1', 2));
    expect(indexes.a.removeCopy).toHaveBeenCalledWith('k1', 'm1', 2);
    expect(indexes.b.removeCopy).toHaveBeenCalledWith('k1', 'm1', 2);
  });
});

describe('labelsOf', () => {
  it('counts label folders as labels alongside the AI ones', () => {
    const doc = searchDoc({
      labels: ['Travel'],
      copies: [copy('m1'), copy('m2', 'label', 'Trips')],
    });
    expect(labelsOf(doc)).toEqual(['Travel', 'Trips']);
  });
});
