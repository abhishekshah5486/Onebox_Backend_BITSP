import { describe, expect, it } from 'vitest';
import { baseEnv, envBoolean, envPort } from './env';

describe('envBoolean', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('parses %s as %s', (input, expected) => {
    expect(envBoolean.parse(input)).toBe(expected);
  });

  it('rejects other strings', () => {
    expect(envBoolean.safeParse('yes').success).toBe(false);
  });
});

describe('envPort', () => {
  it('coerces numeric strings', () => {
    expect(envPort.parse('8080')).toBe(8080);
  });

  it.each(['0', '65536', '80.5', 'http'])('rejects %s', (input) => {
    expect(envPort.safeParse(input).success).toBe(false);
  });
});

describe('baseEnv', () => {
  it('defaults NODE_ENV and LOG_LEVEL', () => {
    expect(baseEnv.parse({})).toEqual({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
  });

  it('rejects unknown NODE_ENV', () => {
    expect(baseEnv.safeParse({ NODE_ENV: 'staging' }).success).toBe(false);
  });
});
