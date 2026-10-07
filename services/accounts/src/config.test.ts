import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadAccountsConfig } from './config';

describe('loadAccountsConfig', () => {
  it('applies defaults and keeps private mail hosts blocked', () => {
    const config = loadAccountsConfig({
      DATABASE_URL: 'postgresql://u:p@h:5432/postgres',
      CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    expect(config).toMatchObject({
      PORT: 4002,
      AUTH_SERVICE_URL: 'http://localhost:4001',
      ALLOW_PRIVATE_MAIL_HOSTS: false,
    });
  });
});
