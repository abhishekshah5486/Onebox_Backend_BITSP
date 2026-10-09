import { createLogger } from '@onebox/logger';
import { describe, expect, it } from 'vitest';
import { oneDriveUploader } from './onedrive';

const logger = createLogger({ service: 'test', level: 'silent' });

describe('oneDriveUploader', () => {
  it('creates missing folders, then uploads through a session without the bearer token', async () => {
    const calls: { url: string; method: string; auth: string | null; body?: unknown }[] = [];
    const send: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      calls.push({ url, method, auth: headers.get('authorization'), body: init?.body });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.endsWith('/root:/OneBox')) return json({ id: 'onebox' });
      if (url.endsWith('/items/onebox:/My%20Receipts')) return json({}, 404);
      if (url.endsWith('/items/onebox/children')) return json({ id: 'receipts' }, 201);
      if (url.endsWith('/items/receipts:/marks.pdf:/createUploadSession')) {
        return json({ uploadUrl: 'https://upload.example/s1' });
      }
      if (url === 'https://upload.example/s1') {
        return json({ id: 'f1', name: 'marks.pdf', webUrl: 'https://onedrive.example/f1' }, 201);
      }
      return json({}, 500);
    };

    const uploader = oneDriveUploader(logger, send);
    const folder = await uploader.folderAt('at', 'acc', 'OneBox/My Receipts');
    expect(folder).toBe('receipts');
    const created = calls.find((call) => call.method === 'POST' && call.url.endsWith('/children'));
    expect(JSON.parse(created!.body as string)).toMatchObject({ name: 'My Receipts', folder: {} });

    const file = await uploader.upload('at', folder, {
      name: 'marks.pdf',
      type: 'application/pdf',
      body: Buffer.from('%PDF'),
    });
    expect(file).toEqual({ name: 'marks.pdf', link: 'https://onedrive.example/f1' });
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.auth).toBeNull();
    expect(calls.filter((call) => call.method !== 'PUT').every((c) => c.auth === 'Bearer at')).toBe(
      true,
    );

    // Cached: the same path needs no more lookups.
    const before = calls.length;
    await uploader.folderAt('at', 'acc', 'OneBox/My Receipts');
    expect(calls.length).toBe(before);
  });
});
