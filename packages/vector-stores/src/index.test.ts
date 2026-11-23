import { describe, expect, it } from 'vitest';
import { checkVectorStore } from './index';

describe('checkVectorStore', () => {
  it("says a store couldn't be reached, reading the cause behind fetch's error", async () => {
    await expect(
      checkVectorStore('QDRANT', { url: 'http://127.0.0.1:59999' }),
    ).rejects.toMatchObject({
      name: 'StoreCheckError',
      message: "Couldn't reach the store",
    });
    await expect(
      checkVectorStore('CHROMA', { url: 'http://127.0.0.1:59999' }),
    ).rejects.toMatchObject({
      message: "Couldn't reach the store",
    });
  });
});
