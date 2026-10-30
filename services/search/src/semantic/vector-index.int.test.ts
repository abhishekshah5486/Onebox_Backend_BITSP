import { QdrantClient } from '@qdrant/js-client-rest';
import { startQdrant, type TestService } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseQuery } from '../query/parse';
import { searchDoc } from '../test-doc';
import { createVectorIndex, type VectorIndex } from './vector-index';

let qdrant: TestService;
let index: VectorIndex;

// Points in four dimensions: travel mail near [1,0,0,0], shopping near [0,1,0,0].
const vectors: Record<string, number[]> = {
  travel: [1, 0.1, 0, 0],
  shopping: [0.1, 1, 0, 0],
};
const embed = vi.fn(async (texts: string[]) =>
  texts.map((text) => (text.includes('Flight') ? vectors.travel! : vectors.shopping!)),
);

beforeAll(async () => {
  qdrant = await startQdrant();
  index = createVectorIndex(new QdrantClient({ url: qdrant.url }), 'mail_test', 4);
  await index.ensure();
  await index.ensure();
}, 120_000);

afterAll(async () => {
  await qdrant?.stop();
});

describe('vector index', () => {
  it('embeds a message once even when it sits in several folders', async () => {
    const trip = searchDoc({ messageId: 'm1', threadId: 'trip', subject: 'Flight to Paris' });
    expect(await index.upsert(trip, embed)).toBe(true);
    expect(await index.upsert({ ...trip, messageId: 'm1-all', role: 'archive' }, embed)).toBe(true);
    expect(await index.upsert({ ...trip, isRead: false }, embed)).toBe(false);
    expect(embed).toHaveBeenCalledTimes(1);

    await index.upsert(searchDoc({ messageId: 'm2', threadId: 'promo', subject: 'Sale' }), embed);
    await index.upsert(
      searchDoc({ messageId: 'm3', threadId: 'x', userId: 'u2', subject: 'Flight' }),
      embed,
    );
    expect(embed).toHaveBeenCalledTimes(3);
  });

  it('ranks by meaning, one hit per conversation, for that user only', async () => {
    const hits = await index.search('u1', [1, 0, 0, 0], parseQuery('trips'), 10);
    expect(hits.map((hit) => hit.threadId)).toEqual(['trip', 'promo']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('applies operators as filters', async () => {
    const unread = await index.search('u1', [1, 0, 0, 0], parseQuery('trips is:unread'), 10);
    expect(unread.map((hit) => hit.threadId)).toEqual(['trip']);
    const fromAlice = await index.search('u1', [0, 1, 0, 0], parseQuery('x from:alice'), 10);
    expect(fromAlice).toHaveLength(2);
    const fromBob = await index.search('u1', [0, 1, 0, 0], parseQuery('x from:bob'), 10);
    expect(fromBob).toEqual([]);
  });

  it('removes a message', async () => {
    await index.remove('m2');
    const hits = await index.search('u1', [0, 1, 0, 0], parseQuery('sale'), 10);
    expect(hits.map((hit) => hit.threadId)).toEqual(['trip']);
  });
});
