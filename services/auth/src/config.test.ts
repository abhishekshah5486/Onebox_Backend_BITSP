import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from './config';

const key = randomBytes(32).toString('base64');

describe('loadAuthConfig', () => {
  it('loads with a default port', () => {
    const config = loadAuthConfig({
      DATABASE_URL: 'postgresql://u:p@host:5432/postgres',
      CREDENTIALS_ENCRYPTION_KEY: key,
    });
    expect(config.PORT).toBe(4001);
    expect(config.CREDENTIALS_ENCRYPTION_KEY).toHaveLength(32);
  });

  it('rejects a non-postgres url', () => {
    expect(() =>
      loadAuthConfig({ DATABASE_URL: 'mongodb://x', CREDENTIALS_ENCRYPTION_KEY: key }),
    ).toThrow(/DATABASE_URL/);
  });
});
