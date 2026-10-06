import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

// OWASP argon2id baseline: 19 MiB memory, 2 iterations, 1 lane.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// Upper bound stops very long inputs from being used to burn hashing CPU.
export const passwordSchema = z.string().min(10).max(128);

export const hashPassword = (password: string) => hash(password, OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

// Verifying against a dummy hash keeps unknown-email logins as slow as wrong-password ones.
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
  return false;
}
