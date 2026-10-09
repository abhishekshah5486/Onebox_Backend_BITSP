import { storagePathParts } from '@onebox/contracts';
import { ExternalServiceError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Uploader } from './uploader';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';

export function googleDriveUploader(logger: Logger, send: typeof fetch = fetch): Uploader {
  // Folder ids by account and path. drive.file only sees folders OneBox created, so a path is
  // always made of our own folders, created the first time it is used.
  const folders = new Map<string, string>();

  async function drive(token: string, url: string, init: RequestInit = {}) {
    const response = await send(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'google drive request failed');
      throw new ExternalServiceError('Google Drive did not accept the file');
    }
    return response;
  }

  async function childFolder(token: string, parent: string, name: string) {
    const quoted = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const query = `mimeType='${FOLDER_TYPE}' and name='${quoted}' and '${parent}' in parents and trashed=false`;
    const found = (await (
      await drive(
        token,
        `${DRIVE_FILES}?${new URLSearchParams({ q: query, fields: 'files(id)' }).toString()}`,
      )
    ).json()) as { files: { id: string }[] };
    if (found.files[0]) return found.files[0].id;
    const created = await drive(token, `${DRIVE_FILES}?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_TYPE, parents: [parent] }),
    });
    return ((await created.json()) as { id: string }).id;
  }

  return {
    async folderAt(token, accountId, path) {
      let parent = 'root';
      let walked = '';
      for (const name of storagePathParts(path)) {
        walked = walked ? `${walked}/${name}` : name;
        const key = `${accountId}:${walked}`;
        parent = folders.get(key) ?? (await childFolder(token, parent, name));
        folders.set(key, parent);
      }
      return parent;
    },

    // Resumable upload: one request for the session, one for the bytes, at any size.
    async upload(token, folder, { name, type, body }) {
      const session = await drive(
        token,
        `${DRIVE_UPLOAD}?uploadType=resumable&fields=id,name,webViewLink`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-upload-content-type': type,
            'x-upload-content-length': String(body.length),
          },
          body: JSON.stringify({ name, parents: [folder] }),
        },
      );
      const location = session.headers.get('location');
      if (!location) throw new ExternalServiceError('Google Drive did not start the upload');
      const done = await drive(token, location, {
        method: 'PUT',
        headers: { 'content-type': type },
        body: new Uint8Array(body),
      });
      const file = (await done.json()) as { name: string; webViewLink: string };
      return { name: file.name, link: file.webViewLink };
    },

    forget(accountId) {
      for (const key of folders.keys()) if (key.startsWith(`${accountId}:`)) folders.delete(key);
    },
  };
}
