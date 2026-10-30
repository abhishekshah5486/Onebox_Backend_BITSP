import { describe, expect, it } from 'vitest';
import { loadSearchConfig } from './config';

const KEY = Buffer.alloc(32, 1).toString('base64');

describe('loadSearchConfig', () => {
  it('defaults the port and local search stores', () => {
    expect(
      loadSearchConfig({ REDIS_URL: 'redis://localhost:6379', CREDENTIALS_ENCRYPTION_KEY: KEY }),
    ).toMatchObject({
      PORT: 4011,
      ELASTICSEARCH_URL: 'http://localhost:9200',
      ELASTICSEARCH_INDEX: 'mail-messages',
      QDRANT_URL: 'http://localhost:6333',
    });
  });

  it('needs the key that signs calls to llm-proxy', () => {
    expect(() => loadSearchConfig({ REDIS_URL: 'redis://localhost:6379' })).toThrow(
      /CREDENTIALS_ENCRYPTION_KEY/,
    );
  });
});
