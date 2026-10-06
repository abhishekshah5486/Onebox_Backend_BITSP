import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, decrypt, encrypt, encryptionKeySchema } from './aes-gcm';

const key = randomBytes(32);

describe('encrypt/decrypt', () => {
  it('round-trips unicode plaintext', () => {
    const secret = 'app-password ✓ 🔐';
    expect(decrypt(encrypt(secret, key), key)).toBe(secret);
  });

  it('produces a different ciphertext each time', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('never contains the plaintext', () => {
    expect(encrypt('hunter2-password', key)).not.toContain('hunter2');
  });

  it('fails with the wrong key', () => {
    expect(() => decrypt(encrypt('x', key), randomBytes(32))).toThrow(DecryptionError);
  });

  it('fails when the aad does not match', () => {
    const token = encrypt('x', key, 'account-1');
    expect(decrypt(token, key, 'account-1')).toBe('x');
    expect(() => decrypt(token, key, 'account-2')).toThrow(DecryptionError);
  });

  it('fails on tampered ciphertext', () => {
    const [v, iv, tag, ct] = encrypt('secret', key).split('.');
    const flipped = Buffer.from(ct ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64url')].join('.'), key)).toThrow(
      DecryptionError,
    );
  });

  it.each(['', 'v2.a.b.c', 'v1.only'])('rejects malformed token %j', (token) => {
    expect(() => decrypt(token, key)).toThrow(DecryptionError);
  });
});

describe('encryptionKeySchema', () => {
  it('accepts a base64 32-byte key', () => {
    expect(encryptionKeySchema.parse(key.toString('base64'))).toEqual(key);
  });

  it.each([randomBytes(16).toString('base64'), 'not base64!'])('rejects %s', (value) => {
    expect(encryptionKeySchema.safeParse(value).success).toBe(false);
  });
});
