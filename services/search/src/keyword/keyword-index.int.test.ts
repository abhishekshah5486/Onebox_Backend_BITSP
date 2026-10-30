import { Client } from '@elastic/elasticsearch';
import { startElasticsearch, type TestService } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseQuery } from '../query/parse';
import { searchDoc } from '../test-doc';
import { createKeywordIndex, type KeywordIndex } from './keyword-index';

let es: TestService;
let client: Client;
let index: KeywordIndex;

const ids = async (q: string, userId = 'u1') => {
  const { hits } = await index.search(userId, parseQuery(q), { from: 0, size: 20 });
  return hits.map((hit) => hit.threadId);
};

beforeAll(async () => {
  es = await startElasticsearch();
  client = new Client({ node: es.url });
  index = createKeywordIndex(client, 'mail-test');
  await index.ensure();
  await index.ensure();
  const docs = [
    searchDoc({
      messageId: 'm1',
      threadId: 'trip',
      subject: 'Flight to Paris',
      body: 'Your booking for the quarterly report offsite is confirmed',
      attachmentNames: ['ticket.pdf'],
      labels: ['Travel'],
      categories: ['travel'],
      sizeBytes: 3 * 1024 * 1024,
      receivedAt: '2026-10-20T10:00:00.000Z',
    }),
    // The same mail as it sits in All Mail: one result per conversation.
    searchDoc({
      messageId: 'm1-all',
      threadId: 'trip',
      folder: '[Gmail]/All Mail',
      role: 'archive',
      subject: 'Flight to Paris',
      receivedAt: '2026-10-20T10:00:00.000Z',
    }),
    searchDoc({
      messageId: 'm2',
      threadId: 'promo',
      from: { name: 'Shop', address: 'deals@shop.com' },
      subject: 'Huge sale',
      body: 'Cheap flights and <b>more</b>',
      isRead: false,
      receivedAt: '2026-10-25T10:00:00.000Z',
    }),
    searchDoc({ messageId: 'm3', threadId: 'junk', role: 'spam', subject: 'Paris prize' }),
    searchDoc({ messageId: 'm4', threadId: 'other', userId: 'u2', subject: 'Paris for u2' }),
  ];
  for (const doc of docs) await index.upsert(doc);
  await client.indices.refresh({ index: 'mail-test' });
}, 240_000);

afterAll(async () => {
  await client?.close();
  await es?.stop();
});

describe('keyword index', () => {
  it('finds words across fields, newest first, one hit per conversation', async () => {
    expect(await ids('flights')).toEqual(['promo', 'trip']);
    expect(await ids('cheap')).toEqual(['promo']);
    expect(await ids('paris')).toEqual(['trip']);
    expect(await ids('alice')).toEqual(['trip']);
    const { total } = await index.search('u1', parseQuery(''), { from: 0, size: 20 });
    expect(total).toBe(2);
  });

  it('matches phrases, exclusions and senders', async () => {
    expect(await ids('"quarterly report"')).toEqual(['trip']);
    expect(await ids('"report quarterly"')).toEqual([]);
    expect(await ids('flight -paris')).toEqual(['promo']);
    expect(await ids('from:deals@shop.com')).toEqual(['promo']);
    expect(await ids('from:shop.com')).toEqual(['promo']);
    expect(await ids('from:shop')).toEqual(['promo']);
    expect(await ids('-from:alice')).toEqual(['promo']);
  });

  it('filters by label, category, state, attachment, size and date', async () => {
    expect(await ids('label:travel')).toEqual(['trip']);
    expect(await ids('category:travel')).toEqual(['trip']);
    expect(await ids('is:unread')).toEqual(['promo']);
    expect(await ids('has:attachment filename:ticket')).toEqual(['trip']);
    expect(await ids('filename:pdf')).toEqual(['trip']);
    expect(await ids('larger:2M')).toEqual(['trip']);
    expect(await ids('after:2026/10/22')).toEqual(['promo']);
    expect(await ids('in:inbox before:2026/10/22')).toEqual(['trip']);
  });

  it('leaves spam out unless asked, and never shows other users mail', async () => {
    expect(await ids('prize')).toEqual([]);
    expect(await ids('prize in:spam')).toEqual(['junk']);
    expect(await ids('paris', 'u2')).toEqual(['other']);
  });

  it('highlights matches with the mail markup escaped', async () => {
    const { hits } = await index.search('u1', parseQuery('cheap'), { from: 0, size: 5 });
    expect(hits[0]?.highlights.join(' ')).toContain('<mark>Cheap</mark> flights and &lt;b&gt;more');
  });

  it('removes a message', async () => {
    await index.remove('m2');
    await index.remove('missing');
    await client.indices.refresh({ index: 'mail-test' });
    expect(await ids('cheap')).toEqual([]);
  });
});
