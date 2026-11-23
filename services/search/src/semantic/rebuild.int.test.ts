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
import { copy, searchDoc } from '../test-doc';
import { reembedHandler } from '../workers';
import { createSemanticModels } from './models';

const logger = createLogger({ service: 'test', level: 'silent' });
const oldModel: EmbedModel = { id: 'ollama/old', name: 'old', dimensions: 2, local: true };
const newModel: EmbedModel = { id: 'ollama/new', name: 'new', dimensions: 3, local: true };

let elastic: TestService;
let qdrantServer: TestService;
let redisServer: TestRedis;
let redis: Redis;
let qdrant: QdrantClient;
let es: Client;
let keyword: KeywordIndex;

beforeAll(async () => {
  [elastic, qdrantServer, redisServer] = await Promise.all([
    startElasticsearch(),
    startQdrant(),
    startRedis(),
  ]);
  redis = new Redis(redisServer.url);
  qdrant = new QdrantClient({ url: qdrantServer.url });
  es = new Client({ node: elastic.url });
  keyword = createKeywordIndex(es, 'mail-rebuild-test');
  await keyword.ensure();
}, 240_000);

afterAll(async () => {
  await redis?.quit();
  await es?.close();
  await Promise.all([elastic?.stop(), qdrantServer?.stop(), redisServer?.stop()]);
});

describe('switching embedding model', () => {
  it("embeds all of the user's mail with the new model, then moves their searches to it", async () => {
    // 70 emails for u1 (more than one page), one for someone else.
    for (let i = 0; i < 70; i += 1) {
      await keyword.upsert(
        searchDoc({ key: `k${i}`, copies: [copy(`m${i}`)], subject: `Mail ${i}` }),
        10 + i,
      );
    }
    await keyword.upsert(searchDoc({ key: 'other', userId: 'u2' }), 5);
    await es.indices.refresh({ index: 'mail-rebuild-test' });

    let chosen = newModel;
    const models = createSemanticModels({
      qdrant,
      redis,
      fetchModel: async () => chosen,
      defaultModel: oldModel,
    });
    // Before the switch: u1's mail is in the old model's collection.
    const old = await models.indexFor(oldModel);
    await old.upsert(searchDoc(), 1, async () => [[1, 0]]);

    const embed = vi.fn(async ({ texts }: { texts: string[] }) => texts.map(() => [1, 0, 0]));
    const handle = reembedHandler({ models, keyword, embed, logger });
    const job = createJobEnvelope({
      jobId: 'r1',
      userId: 'u1',
      payload: { modelId: newModel.id },
    });

    // A switch made moot by a later one does nothing.
    chosen = oldModel;
    await handle(job);
    expect(embed).not.toHaveBeenCalled();

    chosen = newModel;
    await handle(job);
    // Two pages of 32 and one of 6, all with the new model, none charged.
    expect(embed.mock.calls.map(([call]) => call.texts.length)).toEqual([32, 32, 6]);
    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', charge: false, model: 'ollama/new' }),
    );
    const fresh = await models.indexFor(newModel);
    expect((await qdrant.count(fresh.collection, { exact: true })).count).toBe(70);

    expect(await models.active('u1')).toEqual(newModel);
    expect(await models.rebuildOf('u1')).toBeNull();
    expect((await qdrant.count(old.collection, { exact: true })).count).toBe(0);

    // Running it again (a retry) embeds nothing new.
    embed.mockClear();
    await handle(job);
    expect(embed).not.toHaveBeenCalled();
  });
});
