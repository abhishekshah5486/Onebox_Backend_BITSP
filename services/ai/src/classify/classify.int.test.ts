import { randomUUID } from 'node:crypto';
import {
  createJobEnvelope,
  MAIL_CATEGORY_DESCRIPTIONS,
  QUEUES,
  type MailboxChangePayload,
} from '@onebox/contracts';
import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { PaymentRequiredError } from '@onebox/errors';
import { createLogger } from '@onebox/logger';
import { createProducer } from '@onebox/queue';
import { startMongo, startRedis, type TestMongo, type TestRedis } from '@onebox/testing';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { aiCollections, ensureIndexes, type AiCollections } from '../db/collections';
import { createCategoryRules } from '../labels/category-rules';
import { createLabelRules } from '../labels/label-rules';
import { createSuggestions } from '../suggestions/suggestions';
import { createClassifyHandler } from './classify';
import type { LlmClient } from './llm-client';

const logger = createLogger({ service: 'test', level: 'silent' });
const context = { logger, attempt: 1 };

let mongo: TestMongo;
let handle: MongoHandle;
let collections: AiCollections;
let redisContainer: TestRedis;
let changes: ReturnType<typeof createProducer<MailboxChangePayload>>;
let changeQueue: Queue;

beforeAll(async () => {
  [mongo, redisContainer] = await Promise.all([startMongo(), startRedis()]);
  handle = await connectMongo(mongo.uri, 'onebox_ai_test');
  collections = aiCollections(handle.db);
  await ensureIndexes(collections);
  changes = createProducer(QUEUES.mailboxChanges, { redisUrl: redisContainer.url, logger });
  changeQueue = new Queue(QUEUES.mailboxChanges, { connection: { url: redisContainer.url } });
});

afterAll(async () => {
  await changes.close();
  await changeQueue.close();
  await handle.close();
  await Promise.all([mongo.stop(), redisContainer.stop()]);
});

const job = (
  userId: string,
  accountId: string,
  messageId = randomUUID().replace(/-/g, '').padEnd(64, '0'),
  categorize = false,
) =>
  createJobEnvelope({
    jobId: `classify-${messageId}`,
    userId,
    accountId,
    payload: {
      messageId,
      threadId: 't1',
      from: 'Priya <priya@acme.example>',
      to: 'me@onebox.test',
      subject: 'Pricing for 20 seats?',
      body: 'Hi, could you send pricing for 20 seats and a demo slot next week?',
      snippet: 'Hi, could you send pricing',
      receivedAt: '2026-10-08T10:00:00.000Z',
      categorize,
    },
  });

const changesFor = async (messageId: string) =>
  (await changeQueue.getJobs(['waiting']))
    .map((j) => (j.data as { payload: MailboxChangePayload }).payload)
    .filter((p) => 'messageId' in p && p.messageId === messageId);

const taggedFor = async (messageId: string) =>
  (await changeQueue.getJobs(['waiting']))
    .map((j) => (j.data as { payload: MailboxChangePayload }).payload)
    .filter((p) => p.type === 'tagged' && p.messageId === messageId);

describe('classification', () => {
  it('applies auto labels, waits on suggested ones, and ignores weak or invented picks', async () => {
    const userId = randomUUID();
    const accountId = randomUUID();
    const rules = createLabelRules(collections);
    await rules.save(userId, {
      accountId,
      path: 'Leads',
      name: 'Leads',
      description: 'Prospects asking about pricing or buying',
      mode: 'auto',
    });
    await rules.save(userId, {
      accountId,
      path: 'Meetings',
      name: 'Meetings',
      description: 'Requests to schedule a call or demo',
      mode: 'suggest',
    });
    await rules.save(userId, {
      accountId,
      path: 'Travel',
      name: 'Travel',
      description: 'Flights, hotels and trips',
      mode: 'auto',
    });
    const llm = vi.fn<LlmClient>(async () => ({
      model: 'gemini-3.8-flash',
      output: {
        labels: [
          { id: 'L1', confidence: 0.92, reason: 'Asks for pricing' },
          { id: 'L2', confidence: 0.81, reason: 'Wants a demo slot' },
          { id: 'L3', confidence: 0.2, reason: 'Unlikely' },
          { id: 'L9', confidence: 0.99, reason: 'Made up' },
        ],
      },
    }));
    const envelope = job(userId, accountId);
    await createClassifyHandler({ collections, llm, changes })(envelope, context);

    // The model only ever saw the labels' short ids and descriptions.
    const request = llm.mock.calls[0]![0];
    expect(request.messages[0]!.content).toContain('L1 "Leads": Prospects asking about pricing');
    expect(request.messages[1]!.content).toMatch(/^<email>[\s\S]*<\/email>$/);

    const id = envelope.payload.messageId;
    const stored = await collections.classifications.findOne({ _id: id });
    expect(stored).toMatchObject({ pending: true, model: 'gemini-3.8-flash' });
    expect(stored!.results.map((r) => [r.path, r.status])).toEqual([
      ['Leads', 'applied'],
      ['Meetings', 'pending'],
    ]);
    expect(await taggedFor(id)).toEqual([
      { type: 'tagged', messageId: id, add: ['Leads'], remove: [] },
    ]);

    const suggestions = createSuggestions({ collections, changes, logger });
    expect(await suggestions.count(userId)).toBe(1);
    await suggestions.decide(userId, id, 'Meetings', true);
    expect(await suggestions.count(userId)).toBe(0);
    expect((await taggedFor(id)).map((p) => p.type === 'tagged' && p.add)).toContainEqual([
      'Meetings',
    ]);
    await expect(suggestions.decide(randomUUID(), id, 'Meetings', true)).rejects.toThrow(
      'not found',
    );
  });

  it('leaves the mail unsorted, without retrying, when the user is out of credits', async () => {
    const userId = randomUUID();
    const accountId = randomUUID();
    await createLabelRules(collections).save(userId, {
      accountId,
      path: 'Leads',
      name: 'Leads',
      description: 'Prospects asking about pricing or buying',
      mode: 'auto',
    });
    const llm = vi.fn<LlmClient>(async () => {
      throw new PaymentRequiredError('The user is out of AI credits', { code: 'OUT_OF_CREDITS' });
    });
    const envelope = job(userId, accountId);
    await createClassifyHandler({ collections, llm, changes })(envelope, context);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(
      await collections.classifications.findOne({ _id: envelope.payload.messageId }),
    ).toBeNull();
  });

  it('makes no model call when the account has no described labels', async () => {
    const llm = vi.fn<LlmClient>();
    await createClassifyHandler({ collections, llm, changes })(
      job(randomUUID(), randomUUID()),
      context,
    );
    expect(llm).not.toHaveBeenCalled();
  });

  it("fills in the user's categories where Gmail gave none, even with no labels", async () => {
    const userId = randomUUID();
    const categories = createCategoryRules(collections);
    await categories.save(userId, 'purchases', {
      description: 'Orders and receipts, including food delivery bills',
    });
    await categories.save(userId, 'social', { enabled: false });
    const llm = vi.fn<LlmClient>(async () => ({
      model: 'gemini-3.8-flash',
      output: {
        labels: [],
        categories: [
          { id: 'purchases', confidence: 0.9, reason: 'An order receipt' },
          { id: 'updates', confidence: 0.3, reason: 'Unlikely' },
          { id: 'social', confidence: 0.95, reason: 'Switched off' },
        ],
      },
    }));
    const envelope = job(userId, randomUUID(), undefined, true);
    await createClassifyHandler({ collections, llm, changes })(envelope, context);

    const system = llm.mock.calls[0]![0].messages[0]!.content;
    expect(system).toContain('- purchases: Orders and receipts, including food delivery bills');
    expect(system).toContain(`- travel: ${MAIL_CATEGORY_DESCRIPTIONS.travel}`);
    expect(system).not.toContain('- social:');
    const id = envelope.payload.messageId;
    expect(await changesFor(id)).toEqual([
      { type: 'categorized', messageId: id, categories: ['purchases'] },
    ]);
    expect(await collections.classifications.findOne({ _id: id })).toMatchObject({
      categories: ['purchases'],
    });

    // Mail Gmail already sorted needs no model call for categories.
    const sorted = vi.fn<LlmClient>();
    await createClassifyHandler({ collections, llm: sorted, changes })(
      job(userId, randomUUID()),
      context,
    );
    expect(sorted).not.toHaveBeenCalled();
  });

  it('starts every category on with its default description, and can reset one', async () => {
    const userId = randomUUID();
    const categories = createCategoryRules(collections);
    expect((await categories.list(userId)).find((c) => c.category === 'travel')).toEqual({
      category: 'travel',
      description: MAIL_CATEGORY_DESCRIPTIONS.travel,
      defaultDescription: MAIL_CATEGORY_DESCRIPTIONS.travel,
      customized: false,
      enabled: true,
    });
    await categories.save(userId, 'travel', { description: 'Trips and bookings for work' });
    expect(await categories.save(userId, 'travel', { enabled: false })).toMatchObject({
      description: 'Trips and bookings for work',
      customized: true,
      enabled: false,
    });
    expect(await categories.save(userId, 'travel', { description: null })).toMatchObject({
      description: MAIL_CATEGORY_DESCRIPTIONS.travel,
      customized: false,
      enabled: false,
    });
    await expect(categories.save(userId, 'travel', { description: 'trips' })).rejects.toThrow(
      /Describe what belongs/,
    );
  });

  it('needs a description before a label can be used by AI', async () => {
    await expect(
      createLabelRules(collections).save(randomUUID(), {
        accountId: randomUUID(),
        path: 'Misc',
        name: 'Misc',
        description: 'stuff',
        mode: 'auto',
      }),
    ).rejects.toThrow(/Describe what belongs/);
  });
});
