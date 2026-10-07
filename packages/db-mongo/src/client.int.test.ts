import { startMongo, type TestMongo } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMongo, isDuplicateKeyError, type MongoHandle } from './client';

let mongo: TestMongo;
let handle: MongoHandle;

beforeAll(async () => {
  mongo = await startMongo();
  handle = await connectMongo(mongo.uri, 'onebox_test');
});

afterAll(async () => {
  await handle.close();
  await mongo.stop();
});

describe('connectMongo', () => {
  it('pings the database', async () => {
    await expect(handle.ping()).resolves.toBeUndefined();
  });

  it('recognises duplicate key errors', async () => {
    const items = handle.db.collection('items');
    await items.createIndex({ key: 1 }, { unique: true });
    await items.insertOne({ key: 'a' });
    const err = await items.insertOne({ key: 'a' }).catch((e: unknown) => e);
    expect(isDuplicateKeyError(err)).toBe(true);
    expect(isDuplicateKeyError(new Error('x'))).toBe(false);
  });
});
