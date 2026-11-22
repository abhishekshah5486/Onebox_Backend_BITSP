import { createLogger } from '@onebox/logger';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { CUSTOM_PROVIDER, parseCatalog } from './directory';
import { catalogFixture } from './fixture';

const logger = createLogger({ service: 'test', level: 'silent' });
const providers = [...parseCatalog(catalogFixture, null), CUSTOM_PROVIDER];

const app = buildApp({
  logger,
  checks: {},
  routes: {
    catalog: {} as never,
    complete: vi.fn(),
    embed: {} as never,
    embeddingCatalog: {} as never,
    reembed: vi.fn(),
    usage: {} as never,
    directory: {
      providers: async () => providers,
      provider: async (id: string) => providers.find((provider) => provider.id === id) ?? null,
    },
    verifyToken: vi.fn(async () => ({ userId: 'u1', email: 'a@b.c' })),
    internalToken: 'secret',
  },
});
const auth = { authorization: 'Bearer t' };

describe('provider routes', () => {
  it('lists providers as cards, without their models', async () => {
    const response = await app.inject({ url: '/llm/providers', headers: auth });
    const { items } = response.json<{ items: Record<string, unknown>[] }>();
    expect(items.find((item) => item.id === 'openai')).toMatchObject({
      name: 'OpenAI',
      modelCount: 2,
      embeddings: true,
    });
    expect(items[0]).not.toHaveProperty('models');
    expect((await app.inject({ url: '/llm/providers' })).statusCode).toBe(401);
  });

  it('opens one provider with its fields and models', async () => {
    const openai = await app.inject({ url: '/llm/providers/openai', headers: auth });
    expect(openai.json()).toMatchObject({ id: 'openai', models: [{ id: 'gpt-5' }, {}] });
    const missing = await app.inject({ url: '/llm/providers/nope', headers: auth });
    expect(missing.statusCode).toBe(404);
  });
});
