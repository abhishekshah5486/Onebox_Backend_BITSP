import { INTERNAL_TOKEN_HEADER } from '@onebox/auth-kit';
import { AppError, ExternalServiceError, NotFoundError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Readable } from 'node:stream';
import type { AttachmentService } from '../attachments/attachments';
import type { StorageProviderId } from '@onebox/contracts';
import type { Uploader } from './uploader';

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

// Saves attachments to one of the user's cloud storage accounts (connected in settings).
export function createStorageService({
  attachments,
  settingsUrl,
  internalToken,
  logger,
  uploaders,
  fetch: send = fetch,
}: {
  attachments: AttachmentService;
  settingsUrl: string;
  internalToken: string;
  logger: Logger;
  uploaders: Record<StorageProviderId, Uploader>;
  fetch?: typeof fetch;
}) {
  async function accessToken(userId: string, accountId: string) {
    const url = new URL(`/internal/storage/token/${userId}/${accountId}`, settingsUrl);
    const response = await send(url, {
      headers: { [INTERNAL_TOKEN_HEADER]: internalToken },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new NotFoundError(body.message ?? 'Connect cloud storage in Settings first');
    }
    if (!response.ok) throw new ExternalServiceError('Cloud storage is not responding');
    return (await response.json()) as { provider: StorageProviderId; accessToken: string };
  }

  return {
    async save(
      userId: string,
      messageId: string,
      { indexes, accountId, path }: { indexes: number[]; accountId: string; path: string },
    ): Promise<SavedFile[]> {
      const { provider, accessToken: token } = await accessToken(userId, accountId);
      const uploader = uploaders[provider];
      let folder = await uploader.folderAt(token, accountId, path);
      const saved: SavedFile[] = [];
      for (const index of indexes) {
        const { meta, blob } = await attachments.open(userId, messageId, index);
        const file = {
          name: meta.filename,
          type: meta.contentType,
          body: await readAll(blob.body),
        };
        let result;
        try {
          result = await uploader.upload(token, folder, file);
        } catch (err) {
          // A cached folder may have been deleted since; find or create the path again.
          if (!(err instanceof AppError) || !path) throw err;
          uploader.forget(accountId);
          folder = await uploader.folderAt(token, accountId, path);
          result = await uploader.upload(token, folder, file);
        }
        saved.push({ index, ...result });
      }
      logger.info({ count: saved.length, provider }, 'attachments saved to cloud storage');
      return saved;
    },
  };
}

export type StorageService = ReturnType<typeof createStorageService>;
