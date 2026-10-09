import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const VERSION = 'v1';
const IV_BYTES = 12;

export const encryptionKeySchema = z
  .base64()
  .transform((value) => Buffer.from(value, 'base64'))
  .refine((key) => key.length === 32, 'must decode to exactly 32 bytes');

export class DecryptionError extends Error {
  constructor() {
    super('Unable to decrypt value');
    this.name = 'DecryptionError';
  }
}

// aad binds the ciphertext to its owner (e.g. an account id) so it can't be swapped between rows.
export function encrypt(plaintext: string, key: Buffer, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function decrypt(token: string, key: Buffer, aad?: string): string {
  const [version, iv, tag, ciphertext] = token.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new DecryptionError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new DecryptionError();
  }
}
