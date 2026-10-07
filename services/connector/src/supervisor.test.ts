import { describe, expect, it } from 'vitest';
import { backoffMs } from './supervisor';

describe('backoffMs', () => {
  it('grows exponentially with jitter between 50% and 100%', () => {
    expect(backoffMs(1, () => 0)).toBe(1000);
    expect(backoffMs(1, () => 1)).toBe(2000);
    expect(backoffMs(4, () => 1)).toBe(16_000);
  });

  it('caps at five minutes', () => {
    expect(backoffMs(30, () => 1)).toBe(300_000);
  });
});
