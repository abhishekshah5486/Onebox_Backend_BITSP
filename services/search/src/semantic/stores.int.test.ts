import { Client } from '@elastic/elasticsearch';
import { createJobEnvelope } from '@onebox/contracts';
import { createLogger } from '@onebox/logger';
import {
  startElasticsearch,
  startPgvector,
  startQdrant,
  startRedis,
  type TestRedis,
  type TestService,
} from '@onebox/testing';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EmbedModel } from '../clients/embed-client';
import { createKeywordIndex, type KeywordIndex } from '../keyword/keyword-index';
import { parseQuery } from '../query/parse';
import { copy, searchDoc } from '../test-doc';
import { reembedHandler } from '../workers';
import type { VectorStoreSetup } from '@onebox/contracts';
import { createSemanticModels } from './models';

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

const OWN = 'f0000000-0000-4000-8000-000000000001';
type RequestRebuild = (
  userId: string,
  modelId: string,
  reason: string,
  storeId?: string,
) => Promise<void>;
const qdrantModels = (
  setup: () => VectorStoreSetup,
  requestRebuild: RequestRebuild = async () => {},
) =>
  createSemanticModels({
    qdrant: new QdrantClient({ url: oneboxServer.url, checkCompatibility: false }),
    redis,
    fetchModel: async () => model,
    defaultModel: model,
    fetchSetup: async () => setup(),
    requestRebuild,
  });

describe("a user's vector stores", () => {
  it('backs up to every store not paused, catches up a resumed one, and searches the chosen one', async () => {
    for (let i = 0; i < 5; i += 1) {
      await keyword.upsert(searchDoc({ key: `s${i}`, copies: [copy(`sm${i}`)] }), 1);
    }
    await es.indices.refresh({ index: 'mail-stores-test' });

    let setup: VectorStoreSetup = {
      searchStoreId: 'onebox',
      stores: [{ id: 'onebox', provider: 'ONEBOX', paused: false }],
    };
    const requestRebuild = vi.fn(async (_u: string, _m: string, _r: string, _s?: string) => {});
    const models = qdrantModels(() => setup, requestRebuild);
    const embed = vi.fn(async ({ texts }: { texts: string[] }) => texts.map(() => [1, 0, 0]));
    const handle = reembedHandler({ models, keyword, embed, logger });
    const collection = 'mail_ollama_m_3';
    const job = (storeId?: string) =>
      createJobEnvelope({
        jobId: 'j',
        userId: 'u1',
        payload: { modelId: model.id, ...(storeId && { storeId }) },
      });

    // Built on OneBox first.
    await handle(job());
    expect(await count(oneboxServer.url, collection)).toBe(5);

    // The user adds their own Qdrant: it's caught up, and OneBox keeps its copy.
    setup = {
      searchStoreId: 'onebox',
      stores: [
        { id: 'onebox', provider: 'ONEBOX', paused: false },
        { id: OWN, provider: 'QDRANT', paused: false, settings: { url: ownServer.url } },
      ],
    };
    await models.refresh('u1');
    expect(requestRebuild).toHaveBeenCalledWith(
      'u1',
      model.id,
      expect.stringMatching(/^catchup:/),
      OWN,
    );
    await handle(job(OWN));
    expect(await count(ownServer.url, collection)).toBe(5);
    expect(await count(oneboxServer.url, collection)).toBe(5);
    expect(await models.targets('u1')).toHaveLength(2);

    // Paused: new mail skips it, and it's marked behind.
    setup.stores[1]!.paused = true;
    await models.refresh('u1');
    expect(await models.targets('u1')).toHaveLength(1);
    const status = await models.storesOf('u1');
    expect(status.map((store) => [store.id, store.upToDate])).toEqual([
      ['onebox', true],
      [OWN, false],
    ]);
    await keyword.upsert(searchDoc({ key: 's5', copies: [copy('sm5')] }), 1);
    await es.indices.refresh({ index: 'mail-stores-test' });
    for (const { index } of await models.targets('u1')) {
      await index.upsert(searchDoc({ key: 's5', copies: [copy('sm5')] }), 1, async (texts) =>
        texts.map(() => [1, 0, 0]),
      );
    }
    expect(await count(oneboxServer.url, collection)).toBe(6);
    expect(await count(ownServer.url, collection)).toBe(5);

    // Resumed: it catches up on what it missed, embedding only that, not every email again.
    requestRebuild.mockClear();
    embed.mockClear();
    setup.stores[1]!.paused = false;
    await models.refresh('u1');
    expect(requestRebuild).toHaveBeenCalledWith('u1', model.id, expect.any(String), OWN);
    await handle(job(OWN));
    expect(await count(ownServer.url, collection)).toBe(6);
    const embeddedTexts = embed.mock.calls.flatMap(([call]) => call.texts);
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain('Subject: Hello');
    expect((await models.storesOf('u1')).every((store) => store.upToDate)).toBe(true);

    // Searches go to the store chosen for them, even with OneBox's paused.
    setup = {
      ...setup,
      searchStoreId: OWN,
      stores: [{ ...setup.stores[0]!, paused: true }, setup.stores[1]!],
    };
    await models.refresh('u1');
    const { index } = await models.searchTarget('u1');
    expect(index.collection).toBe(collection);
    expect(await models.targets('u1')).toHaveLength(1);
    const hits = await index.search('u1', [1, 0, 0], parseQuery('hello'), 10);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('works the same in a store other than Qdrant, here pgvector', async () => {
    const pg = await startPgvector();
    try {
      for (let i = 0; i < 3; i += 1) {
        await keyword.upsert(
          searchDoc({ key: `p${i}`, userId: 'u2', threadId: `pt${i}`, copies: [copy(`pm${i}`)] }),
          1,
        );
      }
      await es.indices.refresh({ index: 'mail-stores-test' });
      const setup: VectorStoreSetup = {
        searchStoreId: OWN,
        stores: [
          { id: 'onebox', provider: 'ONEBOX', paused: true },
          { id: OWN, provider: 'PGVECTOR', paused: false, settings: pg.settings },
        ],
      };
      const models = qdrantModels(() => setup);
      const embed = vi.fn(async ({ texts }: { texts: string[] }) => texts.map(() => [1, 0, 0]));
      const handle = reembedHandler({ models, keyword, embed, logger });
      await handle(
        createJobEnvelope({
          jobId: 'p',
          userId: 'u2',
          payload: { modelId: model.id, storeId: OWN },
        }),
      );

      const sql = postgres(pg.settings.connectionString!, { onnotice: () => {} });
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from mail_ollama_m_3`;
      await sql.end();
      expect(row?.n).toBe(3);

      const { index } = await models.searchTarget('u2');
      expect(await index.search('u2', [1, 0, 0], parseQuery('hello'), 10)).toHaveLength(3);
      expect(await index.search('u2', [1, 0, 0], parseQuery('label:nothing'), 10)).toEqual([]);
    } finally {
      await pg.stop();
    }
  }, 300_000);
});
