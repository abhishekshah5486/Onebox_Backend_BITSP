import { describe, expect, it } from 'vitest';
import { loadMailConfig } from './config';

describe('loadMailConfig', () => {
  it('defaults to running both the api and the worker', () => {
    expect(
      loadMailConfig({
        MONGO_URI: 'mongodb+srv://u:p@cluster.example',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toMatchObject({
      PORT: 4003,
      MONGO_DB: 'onebox_mail',
      MAIL_ROLE: 'all',
      INGEST_CONCURRENCY: 4,
    });
  });

  it('rejects a non-mongo uri', () => {
    expect(() => loadMailConfig({ MONGO_URI: 'postgres://x', REDIS_URL: 'redis://x' })).toThrow(
      /MONGO_URI/,
    );
  });
});
