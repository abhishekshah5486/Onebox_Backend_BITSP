import { describe, expect, it } from 'vitest';
import { hashPassword, passwordSchema, verifyAgainstDummy, verifyPassword } from './passwords';

describe('passwords', () => {
  it('hashes with argon2id and verifies the right password', async () => {
    const hashed = await hashPassword('correct horse battery');
    expect(hashed).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hashed, 'correct horse battery')).resolves.toBe(true);
    await expect(verifyPassword(hashed, 'wrong horse battery')).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'));
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'whatever1234')).resolves.toBe(false);
  });

  it('always rejects via the dummy hash', async () => {
    await expect(verifyAgainstDummy('dummy-password-for-timing')).resolves.toBe(false);
  });

  it.each([
    ['short', false],
    ['a'.repeat(10), true],
    ['a'.repeat(129), false],
  ])('policy for %s', (password, ok) => {
    expect(passwordSchema.safeParse(password).success).toBe(ok);
  });
});
