import { describe, expect, it } from 'vitest';
import { checkEgress } from './egress';

describe('checkEgress', () => {
  it.each([
    'http://127.0.0.1:1234/v1',
    'http://localhost:4001',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/v1',
    'http://192.168.1.10:11434',
    'http://[::1]:8080',
    'http://0.0.0.0',
  ])('refuses %s', async (url) => {
    await expect(checkEgress(url, false)).rejects.toThrow(/private network|could not be resolved/);
  });

  it('allows public addresses, and local ones when the server is set up for it', async () => {
    await expect(checkEgress('https://1.1.1.1/v1', false)).resolves.toBeUndefined();
    await expect(checkEgress('http://127.0.0.1:1234/v1', true)).resolves.toBeUndefined();
  });

  it('rejects what is not an http url', async () => {
    await expect(checkEgress('file:///etc/passwd', true)).rejects.toThrow(/http/);
    await expect(checkEgress('not a url', true)).rejects.toThrow(/valid URL/);
  });
});
