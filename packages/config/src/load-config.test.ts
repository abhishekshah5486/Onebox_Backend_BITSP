import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig } from './load-config';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  API_KEY: z.string().min(10),
  RETRIES: z.coerce.number().int().default(3),
});

describe('loadConfig', () => {
  it('parses and applies defaults', () => {
    const config = loadConfig(schema, { DATABASE_URL: 'postgres://x', API_KEY: 'k'.repeat(10) });
    expect(config).toEqual({ DATABASE_URL: 'postgres://x', API_KEY: 'k'.repeat(10), RETRIES: 3 });
  });

  it('reports every invalid key at once', () => {
    const error = captureError(() => loadConfig(schema, { RETRIES: 'abc' }));
    expect(error.issues.map((i) => i.split(':')[0])).toEqual([
      'DATABASE_URL',
      'API_KEY',
      'RETRIES',
    ]);
  });

  it('never includes received values in the error', () => {
    const error = captureError(() =>
      loadConfig(schema, { DATABASE_URL: 'postgres://x', API_KEY: 'sk-short' }),
    );
    expect(error.message).not.toContain('sk-short');
  });
});

function captureError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
  }
  throw new Error('expected ConfigError');
}
