import { connectMongo, type MongoHandle } from '@onebox/db-mongo';
import { createLogger } from '@onebox/logger';
import { startMongo, type TestMongo } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes, mailCollections, type MailCollections } from '../db/collections';
import { ingestJob } from '../test/fixtures';
import { createIngestHandler } from './ingest-message';
import { TEXT_VERSION } from './parse';
import { refreshStoredText } from './refresh-text';

const context = { logger: createLogger({ service: 'test', level: 'silent' }), attempt: 1 };

let mongo: TestMongo;
let handle: MongoHandle;
let collections: MailCollections;

beforeAll(async () => {
  mongo = await startMongo();
  handle = await connectMongo(mongo.uri, 'onebox_mail_refresh_test');
  collections = mailCollections(handle.db);
  await ensureIndexes(collections);
});

afterAll(async () => {
  await handle.close();
  await mongo.stop();
});

describe('refreshStoredText', () => {
  it('cleans snippets stored under older rules, and their conversations, once', async () => {
    const job = ingestJob({ messageId: '<old@x>' });
    await createIngestHandler(collections)(job, context);
    expect(await collections.messages.findOne({ _id: job.jobId })).toMatchObject({
      textVersion: TEXT_VERSION,
    });

    // As mail stored before: an html document in the text part, padded with entities.
    const html =
      '<!doctype html><html><body><p>Your parcel is here</p></body></html> &#847; &#65279;';
    await collections.messages.updateOne(
      { _id: job.jobId },
      { $set: { textBody: html, snippet: html.slice(0, 200) }, $unset: { textVersion: '' } },
    );
    const { threadId } = (await collections.messages.findOne({ _id: job.jobId }))!;
    await collections.threads.updateOne({ _id: threadId }, { $set: { snippet: html } });

    expect(await refreshStoredText(collections)).toBe(1);
    const message = await collections.messages.findOne({ _id: job.jobId });
    expect(message).toMatchObject({ snippet: 'Your parcel is here', textVersion: TEXT_VERSION });
    expect(message!.textBody).not.toContain('<');
    expect(await collections.threads.findOne({ _id: threadId })).toMatchObject({
      snippet: 'Your parcel is here',
    });
    expect(await refreshStoredText(collections)).toBe(0);
  });
});
