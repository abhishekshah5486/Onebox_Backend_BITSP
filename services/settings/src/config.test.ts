import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadSettingsConfig } from './config';

describe('loadSettingsConfig', () => {
  it('applies defaults and keeps private webhook hosts blocked', () => {
    const config = loadSettingsConfig({
      DATABASE_URL: 'postgresql://u:p@h:5432/postgres',
      CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    expect(config).toMatchObject({ PORT: 4004, ALLOW_PRIVATE_WEBHOOK_HOSTS: false });
  });
});
