import { describe, expect, it } from 'vitest';
import { isPrivateAddress, resolvePublicHost, type Lookup } from './net-guard';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '142.250.183.109', '2607:f8b0:4004:c1b::6c', '::ffff:8.8.8.8'])(
    'allows %s',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

const lookupTo =
  (...addresses: string[]): Lookup =>
  async () =>
    addresses.map((address) => ({ address }));

describe('resolvePublicHost', () => {
  it('returns the first public address', async () => {
    await expect(
      resolvePublicHost('imap.gmail.com', { lookup: lookupTo('142.250.183.109') }),
    ).resolves.toEqual({ host: 'imap.gmail.com', address: '142.250.183.109' });
  });

  it('rejects a name that resolves to an internal address', async () => {
    await expect(
      resolvePublicHost('evil.example', { lookup: lookupTo('8.8.8.8', '169.254.169.254') }),
    ).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED', statusCode: 400 });
  });

  it('rejects private ip literals without a lookup', async () => {
    await expect(resolvePublicHost('127.0.0.1')).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED',
    });
  });

  it('allows private hosts when explicitly permitted', async () => {
    await expect(
      resolvePublicHost('localhost', { lookup: lookupTo('127.0.0.1'), allowPrivate: true }),
    ).resolves.toMatchObject({ address: '127.0.0.1' });
  });

  it('reports unknown hosts', async () => {
    const failing: Lookup = () => Promise.reject(new Error('ENOTFOUND'));
    await expect(resolvePublicHost('nope.invalid', { lookup: failing })).rejects.toMatchObject({
      code: 'HOST_NOT_FOUND',
    });
  });
});
