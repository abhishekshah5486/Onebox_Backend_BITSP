import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './create-logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('writes JSON with service, level label and ISO time', () => {
    const { lines, stream } = capture();
    createLogger({ service: 'auth' }, stream).info('hello');

    expect(lines[0]).toMatchObject({ service: 'auth', level: 'info', msg: 'hello' });
    expect(new Date(lines[0]?.time as string).toISOString()).toBe(lines[0]?.time);
  });

  it('redacts secrets at top level, nested and in request headers', () => {
    const { lines, stream } = capture();
    createLogger({ service: 'auth' }, stream).info({
      password: 'p',
      account: { apiKey: 'k', refreshToken: 'r' },
      req: { headers: { authorization: 'Bearer x', host: 'api' } },
    });

    expect(lines[0]).toMatchObject({
      password: '[REDACTED]',
      account: { apiKey: '[REDACTED]', refreshToken: '[REDACTED]' },
      req: { headers: { authorization: '[REDACTED]', host: 'api' } },
    });
  });

  it('carries child bindings such as traceId', () => {
    const { lines, stream } = capture();
    createLogger({ service: 'mail' }, stream).child({ traceId: 't-1' }).warn('slow');

    expect(lines[0]).toMatchObject({ service: 'mail', traceId: 't-1', level: 'warn' });
  });

  it('logs the root cause of wrapped errors', () => {
    const { lines, stream } = capture();
    const root = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'ECONNRESET',
    });
    createLogger({ service: 'accounts' }, stream).error(
      { err: new Error('Failed query', { cause: root }) },
      'boom',
    );

    expect(JSON.stringify(lines[0])).toContain('Connection terminated unexpectedly');
  });

  it('drops entries below the configured level', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'mail', level: 'warn' }, stream);
    logger.info('ignored');
    logger.error('kept');

    expect(lines.map((line) => line.msg)).toEqual(['kept']);
  });
});
