import { storagePathParts } from '@onebox/contracts';
import { ExternalServiceError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Uploader } from './uploader';

const UPLOAD = 'https://content.dropboxapi.com/2/files/upload';
const SHARE = 'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings';

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
      const file = (await response.json()) as { id: string; name: string; path_display: string };
      const where = file.path_display.slice(0, file.path_display.lastIndexOf('/'));
      const link = new URL(`https://www.dropbox.com/home${encodeURI(where)}`);
      link.searchParams.set('preview', file.name);
      return { id: file.path_display, name: file.name, link: link.toString() };
    },

    // A public link to the file; Dropbox gives back the existing one if it was shared before.
    async share(token, file) {
      const response = await send(SHARE, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: file.id, settings: { requested_visibility: 'public' } }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        url?: string;
        error?: { '.tag'?: string; shared_link_already_exists?: { metadata?: { url?: string } } };
      };
      if (response.ok && body.url) return body.url;
      const existing = body.error?.shared_link_already_exists?.metadata?.url;
      if (existing) return existing;
      logger.warn(
        { status: response.status, reason: body.error?.['.tag'] },
        'dropbox share failed',
      );
      throw new ExternalServiceError(
        response.status === 401 || response.status === 403
          ? 'Dropbox needs permission to share links. Reconnect Dropbox in Settings.'
          : 'Dropbox could not share the file',
      );
    },

    forget() {},
  };
}
