import { describe, expect, it } from 'vitest';
import { envBoolean, envPoolSize, envPort } from './env';

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

describe('envPoolSize', () => {
  it('defaults to a small pool and accepts a larger one', () => {
    expect(envPoolSize.parse(undefined)).toBe(2);
    expect(envPoolSize.parse('8')).toBe(8);
  });

  it.each(['0', '51', 'many'])('rejects %s', (input) => {
    expect(envPoolSize.safeParse(input).success).toBe(false);
  });
});
