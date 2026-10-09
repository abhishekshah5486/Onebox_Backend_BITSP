import { describe, expect, it } from 'vitest';
import { drivePathSchema } from './drive';

describe('drivePathSchema', () => {
  it('tidies slashes and spaces', () => {
    expect(drivePathSchema.parse(' /OneBox// Receipts /')).toBe('OneBox/Receipts');
    expect(drivePathSchema.parse('')).toBe('');
  });

  it('rejects very deep or long paths', () => {
    expect(drivePathSchema.safeParse(Array(11).fill('a').join('/')).success).toBe(false);
    expect(drivePathSchema.safeParse('x'.repeat(101)).success).toBe(false);
  });
});
