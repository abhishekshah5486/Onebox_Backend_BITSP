import { describe, expect, it } from 'vitest';
import { cleanName, fromHalfCosine } from './types';

describe('store helpers', () => {
  it('cleans names so names read back from a store map to themselves', () => {
    const clean = (name: string) =>
      cleanName(name, { allowed: /[^a-z0-9-]/g, replace: '-', max: 45 });
    expect(clean('mail_ollama/bge-m3:latest_1024')).toBe('mail-ollama-bge-m3-latest-1024');
    expect(clean(clean('mail_ollama/bge-m3:latest_1024'))).toBe(
      clean('mail_ollama/bge-m3:latest_1024'),
    );
    expect(clean('x'.repeat(60))).toHaveLength(45);
  });

  it('turns half-cosine scores back into cosine', () => {
    expect(fromHalfCosine(1)).toBe(1);
    expect(fromHalfCosine(0.5)).toBe(0);
  });
});
