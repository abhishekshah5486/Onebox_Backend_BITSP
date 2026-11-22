import { Client } from '@elastic/elasticsearch';
import { createJobEnvelope } from '@onebox/contracts';
import { createLogger } from '@onebox/logger';
import {
  startElasticsearch,
  startQdrant,
  startRedis,
  type TestRedis,
  type TestService,
} from '@onebox/testing';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EmbedModel } from '../clients/embed-client';
import { createKeywordIndex, type KeywordIndex } from '../keyword/keyword-index';
import { parseQuery } from '../query/parse';
import { copy, searchDoc } from '../test-doc';
import { reembedHandler } from '../workers';
import { createSemanticModels, type StoreConnection } from './models';

const logger = createLogger({ service: 'test', level: 'silent' });
const model: EmbedModel = { id: 'ollama/m', name: 'm', dimensions: 3, local: true };

let elastic: TestService;
let oneboxServer: TestService;
let ownServer: TestService;
let redisServer: TestRedis;
let redis: Redis;
let es: Client;
let keyword: KeywordIndex;

beforeAll(async () => {
  [elastic, oneboxServer, ownServer, redisServer] = await Promise.all([
    startElasticsearch(),
    startQdrant(),
    startQdrant(),
    startRedis(),
  ]);
  redis = new Redis(redisServer.url);
  es = new Client({ node: elastic.url });
  keyword = createKeywordIndex(es, 'mail-stores-test');
  await keyword.ensure();
}, 300_000);

afterAll(async () => {
  await redis?.quit();
  await es?.close();
  await Promise.all([
    elastic?.stop(),
    oneboxServer?.stop(),
    ownServer?.stop(),
    redisServer?.stop(),
  ]);
});

const count = async (url: string, collection: string) => {
  const client = new QdrantClient({ url, checkCompatibility: false });
  if (!(await client.collectionExists(collection)).exists) return 0;
  return (await client.count(collection, { exact: true })).count;
};

describe("a user's own vector store", () => {
  it('gets their vectors after a move, which then leave OneBox, and searches go there', async () => {
    for (let i = 0; i < 5; i += 1) {
      await keyword.upsert(searchDoc({ key: `s${i}`, copies: [copy(`sm${i}`)] }), 1);
    }
    await es.indices.refresh({ index: 'mail-stores-test' });

    let connection: StoreConnection = { provider: 'ONEBOX' };
    const requestRebuild = vi.fn(async () => {});
    const models = createSemanticModels({
      qdrant: new QdrantClient({ url: oneboxServer.url, checkCompatibility: false }),
      redis,
      fetchModel: async () => model,
      defaultModel: model,
      fetchStore: async () => connection,
      requestRebuild,
    });
    const embed = vi.fn(async ({ texts }: { texts: string[] }) => texts.map(() => [1, 0, 0]));
    const handle = reembedHandler({ models, keyword, embed, logger });
    const job = createJobEnvelope({ jobId: 'j', userId: 'u1', payload: { modelId: model.id } });
    const collection = 'mail_ollama_m_3';

    // Built on OneBox first.
    await handle(job);
    expect(await count(oneboxServer.url, collection)).toBe(5);

    // The user moves to their own Qdrant: new mail notices and asks for a rebuild.
    connection = { provider: 'QDRANT', url: ownServer.url, apiKey: null };
    models.forgetStore('u1');
    const targets = await models.targets('u1');
    expect(requestRebuild).toHaveBeenCalledWith(
      'u1',
      model.id,
      expect.stringMatching(/^store:own:/),
    );
    expect(targets).toHaveLength(1);

    await handle(job);
    expect(await count(ownServer.url, collection)).toBe(5);
    expect(await count(oneboxServer.url, collection)).toBe(0);
    const { index } = await models.searchTarget('u1');
    const hits = await index.search('u1', [1, 0, 0], parseQuery('hello'), 10);
    expect(hits.length).toBeGreaterThan(0);

    // Settled: no more rebuilds asked for.
    requestRebuild.mockClear();
    await models.targets('u1');
    expect(requestRebuild).not.toHaveBeenCalled();

    // Back to OneBox: rebuilt there; what's in their own store is theirs to keep.
    connection = { provider: 'ONEBOX' };
    models.forgetStore('u1');
    await handle(job);
    expect(await count(oneboxServer.url, collection)).toBe(5);
    expect(await count(ownServer.url, collection)).toBe(5);
  });
});
