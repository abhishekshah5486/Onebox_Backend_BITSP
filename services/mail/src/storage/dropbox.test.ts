import { createLogger } from '@onebox/logger';
import { describe, expect, it } from 'vitest';
import { dropboxUploader } from './dropbox';

const logger = createLogger({ service: 'test', level: 'silent' });

describe('dropboxUploader', () => {
  it('uploads by path, escaping names for the API header', async () => {
    let request: { url: string; headers: Headers } | undefined;
    const send: typeof fetch = async (input, init) => {
      request = {
        url: input instanceof Request ? input.url : input.toString(),
        headers: new Headers(init?.headers),
      };
      return new Response(
        JSON.stringify({ name: 'résumé.pdf', path_display: '/OneBox/Jobs/résumé.pdf' }),
      );
    };
    const uploader = dropboxUploader(logger, send);
    expect(await uploader.folderAt('t', 'a', '')).toBe('');
    const folder = await uploader.folderAt('t', 'a', 'OneBox/Jobs');
    expect(folder).toBe('/OneBox/Jobs');

    const file = await uploader.upload('t', folder, {
      name: 'résumé.pdf',
      type: 'application/pdf',
      body: Buffer.from('%PDF'),
    });
    const arg = request!.headers.get('dropbox-api-arg')!;
    expect(arg).toContain('r\\u00e9sum\\u00e9.pdf');
    expect(JSON.parse(arg)).toMatchObject({ path: '/OneBox/Jobs/résumé.pdf', autorename: true });
    expect(request!.headers.get('authorization')).toBe('Bearer t');
    expect(file.link).toBe('https://www.dropbox.com/home/OneBox/Jobs?preview=r%C3%A9sum%C3%A9.pdf');
  });
});
