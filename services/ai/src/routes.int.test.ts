import { randomUUID } from 'node:crypto';
import type { TokenVerifier } from '@onebox/auth-kit';
import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { UnauthorizedError } from '@onebox/errors';
import { createLogger } from '@onebox/logger';
import { startMongo, type TestMongo } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { aiCollections, type AiCollections } from './db/collections';
import { createCategoryRules } from './labels/category-rules';
import { createLabelRules } from './labels/label-rules';
import type { Suggestions } from './suggestions/suggestions';

const logger = createLogger({ service: 'test', level: 'silent' });
const verifyToken: TokenVerifier = async (token) => {
  if (!token.startsWith('user-')) throw new UnauthorizedError('Invalid access token');
  return { userId: token.slice(5), email: 'a@onebox.dev' };
};

let mongo: TestMongo;
let handle: MongoHandle;
let collections: AiCollections;

beforeAll(async () => {
  mongo = await startMongo();
  handle = await connectMongo(mongo.uri, 'onebox_ai_routes_test');
  collections = aiCollections(handle.db);
});

afterAll(async () => {
  await handle.close();
  await mongo.stop();
});

const app = () =>
  buildApp({
    logger,
    checks: {},
    routes: {
      labels: createLabelRules(collections),
      categories: createCategoryRules(collections),
      suggestions: {} as Suggestions,
      verifyToken,
    },
  });

describe('category routes', () => {
  it('lists the default categories and saves a user’s own description and switch', async () => {
    const server = app();
    const headers = { authorization: `Bearer user-${randomUUID()}` };
    expect((await server.inject({ url: '/ai/categories' })).statusCode).toBe(401);

    const listed = await server.inject({ url: '/ai/categories', headers });
    expect(listed.json<{ items: { category: string }[] }>().items.map((c) => c.category)).toEqual([
      'social',
      'promotions',
      'updates',
      'forums',
      'purchases',
      'travel',
    ]);

    const saved = await server.inject({
      method: 'PUT',
      url: '/ai/categories/updates',
      headers,
      payload: { description: 'Bank alerts and account notices', enabled: false },
    });
    expect(saved.json()).toMatchObject({
      category: 'updates',
      description: 'Bank alerts and account notices',
      customized: true,
      enabled: false,
    });

    const unknown = await server.inject({
      method: 'PUT',
      url: '/ai/categories/receipts',
      headers,
      payload: { enabled: true },
    });
    expect(unknown.statusCode).toBe(400);
  });
});
