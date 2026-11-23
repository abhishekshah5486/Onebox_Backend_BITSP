import { UnauthorizedError } from '@onebox/errors';
import { createLogger } from '@onebox/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { createHub } from './hub';

const logger = createLogger({ service: 'test', level: 'silent' });
const verifyToken = async (token: string) => {
  if (token !== 'good') throw new UnauthorizedError('bad token');
  return { userId: 'u1', email: 'me@example.com' };
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(maxPerUser = 10) {
  const hub = createHub({ maxPerUser });
  const app = buildApp({ logger, checks: {}, hub, verifyToken, heartbeatMs: 50 });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  close = () => app.close();
  return { hub, url: `${address}/events` };
}

// One reader per stream, collecting text until something appears.
function streamOf(response: Response) {
  const reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let text = '';
  return {
    reader,
    until: async (marker: string) => {
      while (!text.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text;
    },
  };
}

describe('GET /events', () => {
  it('needs a valid sign-in', async () => {
    const { url } = await start();
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: 'Bearer bad' } })).status).toBe(401);
  });

  it('streams the user’s events, with heartbeats, until they go', async () => {
    const { url, hub } = await start();
    const response = await fetch(url, { headers: { authorization: 'Bearer good' } });
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const stream = streamOf(response);
    await stream.until('event: ready');
    expect(hub.size).toBe(1);
    hub.deliver('u1', '{"type":"thread.removed","threadId":"t1"}');
    const text = await stream.until(': ping');
    expect(text).toContain('data: {"type":"thread.removed","threadId":"t1"}');

    await stream.reader.cancel();
    await expect.poll(() => hub.size).toBe(0);
  });

  it('turns away a user with too many streams open', async () => {
    const { url } = await start(1);
    const first = await fetch(url, { headers: { authorization: 'Bearer good' } });
    const stream = streamOf(first);
    await stream.until('event: ready');
    expect((await fetch(url, { headers: { authorization: 'Bearer good' } })).status).toBe(429);
    await stream.reader.cancel();
  });

  it('ends open streams when the server shuts down', async () => {
    const { url } = await start();
    const response = await fetch(url, { headers: { authorization: 'Bearer good' } });
    const { reader, until } = streamOf(response);
    await until('event: ready');
    await close!();
    close = undefined;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
});
