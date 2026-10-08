import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { AppError, ExternalServiceError, NotFoundError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Readable } from 'node:stream';
import type { AttachmentService } from '../attachments/attachments';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'OneBox';

export interface SavedFile {
  index: number;
  name: string;
  link: string;
}

async function readAll(body: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function createDriveService({
  attachments,
  settingsUrl,
  internalToken,
  logger,
  fetch: send = fetch,
}: {
  attachments: AttachmentService;
  settingsUrl: string;
  internalToken: string;
  logger: Logger;
  fetch?: typeof fetch;
}) {
  // Folder ids per user; drive.file only sees folders OneBox created, so this stays ours.
  const folders = new Map<string, string>();

  async function accessToken(userId: string) {
    const response = await send(new URL(`/internal/google/token/${userId}`, settingsUrl), {
      headers: { [INTERNAL_TOKEN_HEADER]: internalToken },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new NotFoundError(body.message ?? 'Connect Google Drive in Settings first');
    }
    if (!response.ok) throw new ExternalServiceError('Google Drive is not responding');
    return ((await response.json()) as { accessToken: string }).accessToken;
  }

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

  async function folderId(userId: string, token: string) {
    const cached = folders.get(userId);
    if (cached) return cached;
    const query = `mimeType='${FOLDER_TYPE}' and name='${FOLDER_NAME}' and trashed=false`;
    const found = (await (
      await drive(
        token,
        `${DRIVE_FILES}?${new URLSearchParams({ q: query, fields: 'files(id)' }).toString()}`,
      )
    ).json()) as { files: { id: string }[] };
    let id = found.files[0]?.id;
    if (!id) {
      const created = await drive(token, `${DRIVE_FILES}?fields=id`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_TYPE }),
      });
      id = ((await created.json()) as { id: string }).id;
    }
    folders.set(userId, id);
    return id;
  }

  // Resumable upload: one request for the session, one for the bytes, at any size.
  async function upload(token: string, parent: string, name: string, type: string, body: Buffer) {
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
        body: JSON.stringify({ name, parents: [parent] }),
      },
    );
    const location = session.headers.get('location');
    if (!location) throw new ExternalServiceError('Google Drive did not start the upload');
    const done = await drive(token, location, {
      method: 'PUT',
      headers: { 'content-type': type },
      body: new Uint8Array(body),
    });
    return (await done.json()) as { id: string; name: string; webViewLink: string };
  }

  return {
    async save(userId: string, messageId: string, indexes: number[]): Promise<SavedFile[]> {
      const token = await accessToken(userId);
      let parent = await folderId(userId, token);
      const saved: SavedFile[] = [];
      for (const index of indexes) {
        const { meta, blob } = await attachments.open(userId, messageId, index);
        const content = await readAll(blob.body);
        let file;
        try {
          file = await upload(token, parent, meta.filename, meta.contentType, content);
        } catch (err) {
          // The folder may have been deleted since it was cached; find or create it again.
          if (!(err instanceof AppError) || !folders.has(userId)) throw err;
          folders.delete(userId);
          parent = await folderId(userId, token);
          file = await upload(token, parent, meta.filename, meta.contentType, content);
        }
        saved.push({ index, name: file.name, link: file.webViewLink });
      }
      logger.info({ count: saved.length }, 'attachments saved to google drive');
      return saved;
    },
  };
}

export type DriveService = ReturnType<typeof createDriveService>;
