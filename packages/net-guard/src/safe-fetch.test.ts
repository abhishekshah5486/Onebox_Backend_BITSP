import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeFetch } from './safe-fetch';

let server: Server;
let base: string;
const received: { method?: string; body: string; headers: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push({ method: req.method, body, headers: req.headers });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
      } else if (req.url === '/endless') {
        // Streams until the client hangs up.
        res.writeHead(200);
        const timer = setInterval(() => res.write('x'.repeat(1024)), 1);
        res.on('close', () => clearInterval(timer));
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 500);
      } else {
        res.writeHead(200).end('ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('safeFetch', () => {
  it('blocks private ip literals by default', async () => {
    await expect(safeFetch(`${base}/`)).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
  });

  it('blocks names resolving to private addresses at connect time', async () => {
    await expect(safeFetch('http://localhost:4999/')).rejects.toMatchObject({
      code: 'BLOCKED_HOST',
    });
  });

  it('sends the request when private hosts are allowed', async () => {
    const res = await safeFetch(`${base}/hook`, {
      allowPrivate: true,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test': '1' },
      body: '{"a":1}',
    });
    expect(res).toEqual({ status: 200, ok: true, body: 'ok' });
    expect(received.at(-1)).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      headers: { 'x-test': '1' },
    });
  });

  it('does not follow redirects', async () => {
    const res = await safeFetch(`${base}/redirect`, { allowPrivate: true });
    expect(res).toMatchObject({ status: 302, ok: false });
  });

  it('stops reading a body at the size limit', async () => {
    const res = await safeFetch(`${base}/endless`, {
      allowPrivate: true,
      maxBodyBytes: 4096,
      timeoutMs: 2000,
    });
    expect(res.body).toHaveLength(4096);
  });

  it('times out slow endpoints', async () => {
    await expect(
      safeFetch(`${base}/slow`, { allowPrivate: true, timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('rejects invalid urls', async () => {
    await expect(safeFetch('not a url')).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
});
