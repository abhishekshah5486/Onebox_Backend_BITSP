import { QdrantClient } from '@qdrant/js-client-rest';
import { startQdrant, type TestService } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseQuery } from '../query/parse';
import { copy, searchDoc } from '../test-doc';
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
  const trip = searchDoc({
    key: 'trip-mail',
    copies: [copy('m1'), copy('m1-all', 'archive', '[Gmail]/All Mail')],
    threadId: 'trip',
    subject: 'Flight to Paris',
  });

  it('keeps one point per email and embeds only when its text changes', async () => {
    expect(await index.upsert(trip, 1, embed)).toBe('embedded');
    expect(await index.upsert({ ...trip, isRead: false }, 2, embed)).toBe('updated');
    expect(await index.upsert({ ...trip, subject: 'Old' }, 1, embed)).toBe('stale');
    expect(embed).toHaveBeenCalledTimes(1);

    await index.upsert(
      searchDoc({ key: 'promo-mail', copies: [copy('m2')], threadId: 'promo', subject: 'Sale' }),
      1,
      embed,
    );
    await index.upsert(
      searchDoc({
        key: 'u2-mail',
        copies: [copy('m3')],
        threadId: 'x',
        userId: 'u2',
        subject: 'Flight',
      }),
      1,
      embed,
    );
    expect(embed).toHaveBeenCalledTimes(3);
    const { count } = await new QdrantClient({ url: qdrant.url }).count('mail_test', {
      exact: true,
    });
    expect(count).toBe(3);
  });

  it('ranks by meaning, one hit per conversation, for that user only', async () => {
    const hits = await index.search('u1', [1, 0, 0, 0], parseQuery('trips'), 10);
    expect(hits.map((hit) => hit.threadId)).toEqual(['trip', 'promo']);
    expect(hits[0]!.messageId).toBe('m1');
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

  it('drops copies one by one and the email with its last', async () => {
    expect(await index.removeCopy('trip-mail', 'm1', 3)).toBe(false);
    const inbox = await index.search('u1', [1, 0, 0, 0], parseQuery('trips in:inbox'), 10);
    expect(inbox.map((hit) => hit.threadId)).toEqual(['promo']);
    expect(await index.removeCopy('trip-mail', 'm1-all', 2)).toBe(false);
    expect(await index.removeCopy('trip-mail', 'm1-all', 4)).toBe(true);
    const hits = await index.search('u1', [1, 0, 0, 0], parseQuery('trips'), 10);
    expect(hits.map((hit) => hit.threadId)).toEqual(['promo']);
  });
});
