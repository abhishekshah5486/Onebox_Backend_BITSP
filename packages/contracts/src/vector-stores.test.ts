import { describe, expect, it } from 'vitest';
import { vectorStoreSetupSchema } from './vector-stores';

describe('vectorStoreSetupSchema', () => {
  it('reads OneBox and any number of own stores, each paused or not', () => {
    const setup = {
      searchStoreId: 'a',
      stores: [
        { id: 'onebox', provider: 'ONEBOX', paused: true },
        { id: 'a', provider: 'MILVUS', paused: false, settings: { address: 'x:19530' } },
        { id: 'b', provider: 'MILVUS', paused: true, settings: { address: 'y:19530' } },
      ],
    };
    expect(vectorStoreSetupSchema.parse(setup)).toEqual(setup);
    expect(() => vectorStoreSetupSchema.parse({ ...setup, stores: [{ id: 'c' }] })).toThrow();
  });
});
