import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConnectorConfig } from './config';

describe('loadConnectorConfig', () => {
  it('applies safe defaults', () => {
    expect(
      loadConnectorConfig({
        REDIS_URL: 'redis://localhost:6379',
        CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
    ).toMatchObject({
      PORT: 4005,
      INITIAL_BATCH: 50,
      ALLOW_PRIVATE_MAIL_HOSTS: false,
      INGEST_HIGH_WATERMARK: 500,
    });
  });
});
