import { describe, expect, it } from 'vitest';
import { storagePathSchema } from './storage';

describe('storagePathSchema', () => {
  it('tidies slashes and spaces', () => {
    expect(storagePathSchema.parse(' /OneBox// Receipts /')).toBe('OneBox/Receipts');
    expect(storagePathSchema.parse('')).toBe('');
  });

  it('rejects very deep or long paths', () => {
    expect(storagePathSchema.safeParse(Array(11).fill('a').join('/')).success).toBe(false);
    expect(storagePathSchema.safeParse('x'.repeat(101)).success).toBe(false);
  });
});
