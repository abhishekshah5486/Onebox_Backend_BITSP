import { createLogger } from '@onebox/logger';
import { startGreenMail, type TestMailServer } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImapVerifier } from './verify-imap';

const logger = createLogger({ service: 'test', level: 'silent' });
const user = { email: 'tester@onebox.test', password: 'secret-pass' };

let mail: TestMailServer;

beforeAll(async () => {
  mail = await startGreenMail([user]);
});

afterAll(() => mail.stop());

const verify = createImapVerifier({ logger, allowPrivateHosts: true, timeoutMs: 5000 });
const target = (overrides = {}) => ({
  host: mail.host,
  port: mail.imapPort,
  tls: false,
  username: user.email,
  password: user.password,
  ...overrides,
});

describe('imap verifier', () => {
  it('accepts valid credentials', async () => {
    await expect(verify(target())).resolves.toEqual({ ok: true });
  });

  it('reports a wrong password as AUTH_FAILED', async () => {
    await expect(verify(target({ password: 'wrong' }))).resolves.toMatchObject({
      ok: false,
      reason: 'AUTH_FAILED',
    });
  });

  it('reports a closed port as UNREACHABLE', async () => {
    await expect(verify(target({ port: 1 }))).resolves.toMatchObject({
      ok: false,
      reason: 'UNREACHABLE',
    });
  });

  it('refuses private hosts unless allowed', async () => {
    const strict = createImapVerifier({ logger });
    await expect(strict(target())).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' });
  });
});
