import { Writable } from 'node:stream';
import { createLogger } from '@onebox/logger';
import { NotFoundError } from '@onebox/errors';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createServer, type HttpServer } from './create-server';

function setup() {
  const logs: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  const app = createServer({ logger: createLogger({ service: 'test' }, stream) });
  app.post(
    '/echo',
    { schema: { body: z.object({ email: z.email() }) } },
    async (request) => request.body,
  );
  app.get('/missing', async () => {
    throw new NotFoundError('Thread not found');
  });
  app.get('/boom', async () => {
    throw new Error('db password=secret leaked');
  });
  return { app, logs };
}

let app: HttpServer;
afterEach(() => app.close());

describe('createServer', () => {
  it('serves validated requests and echoes a request id', async () => {
    ({ app } = setup());
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { email: 'a@b.co' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'a@b.co' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates an incoming x-request-id', async () => {
    ({ app } = setup());
    const res = await app.inject({ url: '/missing', headers: { 'x-request-id': 'req-123' } });
    expect(res.headers['x-request-id']).toBe('req-123');
  });

  it('returns 400 with details on validation failure', async () => {
    ({ app } = setup());
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { email: 'nope' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: [{ path: '/email' }] },
    });
  });

  it('maps app errors to their status', async () => {
    ({ app } = setup());
    const res = await app.inject({ url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
  });

  it('masks unexpected errors and logs them', async () => {
    let logs;
    ({ app, logs } = setup());
    const res = await app.inject({ url: '/boom' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
    expect(logs.some((line) => line.msg === 'request failed' && line.level === 'error')).toBe(true);
  });

  it('keeps fastify client errors such as malformed json', async () => {
    ({ app } = setup());
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: '{bad',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns a json 404 for unknown routes', async () => {
    ({ app } = setup());
    const res = await app.inject({ url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('logs one line per request', async () => {
    let logs;
    ({ app, logs } = setup());
    await app.inject({ method: 'POST', url: '/echo', payload: { email: 'a@b.co' } });

    const lines = logs.filter((line) => line.msg === 'request completed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ method: 'POST', url: '/echo', statusCode: 200 });
  });
});
