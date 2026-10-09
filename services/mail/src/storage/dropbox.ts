import { storagePathParts } from '@onebox/contracts';
import { ExternalServiceError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Uploader } from './uploader';

const UPLOAD = 'https://content.dropboxapi.com/2/files/upload';

// Dropbox-API-Arg is an HTTP header, so anything outside ASCII is escaped as JSON allows.
const headerJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

// Dropbox addresses everything by path and creates missing folders while uploading, so a
// "folder" here is just its path ("" is the top).
export function dropboxUploader(logger: Logger, send: typeof fetch = fetch): Uploader {
  return {
    async folderAt(_token, _accountId, path) {
      const parts = storagePathParts(path);
      return parts.length ? `/${parts.join('/')}` : '';
    },

    // Up to 150 MB in one request; ours are far smaller. A name already taken gets " (1)".
    async upload(token, folder, { name, body }) {
      const response = await send(UPLOAD, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'dropbox-api-arg': headerJson({
            path: `${folder}/${name}`,
            mode: 'add',
            autorename: true,
            mute: false,
          }),
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, 'dropbox upload failed');
        throw new ExternalServiceError('Dropbox did not accept the file');
      }
      const file = (await response.json()) as { name: string; path_display: string };
      const where = file.path_display.slice(0, file.path_display.lastIndexOf('/'));
      const link = new URL(`https://www.dropbox.com/home${encodeURI(where)}`);
      link.searchParams.set('preview', file.name);
      return { name: file.name, link: link.toString() };
    },

    forget() {},
  };
}
