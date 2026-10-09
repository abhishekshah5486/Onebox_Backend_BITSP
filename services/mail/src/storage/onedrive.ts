import { storagePathParts } from '@onebox/contracts';
import { ExternalServiceError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Uploader } from './uploader';

const GRAPH = 'https://graph.microsoft.com/v1.0/me/drive';

interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
}

// OneDrive through Microsoft Graph. Folders are looked up by name and created when missing.
export function oneDriveUploader(logger: Logger, send: typeof fetch = fetch): Uploader {
  const folders = new Map<string, string>();

  async function graph(token: string | null, url: string, init: RequestInit = {}) {
    const response = await send(url, {
      ...init,
      // Upload session URLs carry their own authorisation and reject a bearer token.
      headers: { ...(token && { authorization: `Bearer ${token}` }), ...init.headers },
      signal: AbortSignal.timeout(120_000),
    });
    return response;
  }

  const failed = (response: Response) => {
    logger.warn({ status: response.status }, 'onedrive request failed');
    return new ExternalServiceError('OneDrive did not accept the file');
  };

  // Graph addresses a child by path relative to its parent: items/{id}:/{name}.
  const itemPath = (parent: string, name: string) =>
    parent === 'root'
      ? `${GRAPH}/root:/${encodeURIComponent(name)}`
      : `${GRAPH}/items/${parent}:/${encodeURIComponent(name)}`;

  async function childFolder(token: string, parent: string, name: string) {
    const found = await graph(token, itemPath(parent, name));
    if (found.ok) return ((await found.json()) as DriveItem).id;
    if (found.status !== 404) throw failed(found);
    const created = await graph(token, `${GRAPH}/items/${parent}/children`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    });
    // Another save may have just created it.
    if (created.status === 409) return childFolder(token, parent, name);
    if (!created.ok) throw failed(created);
    return ((await created.json()) as DriveItem).id;
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

    // An upload session takes files of any size; ours fit in one request (under 60 MiB). A file
    // with the same name gets a new name rather than replacing it.
    async upload(token, folder, { name, body }) {
      const session = await graph(token, `${itemPath(folder, name)}:/createUploadSession`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
      });
      if (!session.ok) throw failed(session);
      const { uploadUrl } = (await session.json()) as { uploadUrl: string };
      const done = await graph(null, uploadUrl, {
        method: 'PUT',
        headers: {
          'content-length': String(body.length),
          'content-range': `bytes 0-${Math.max(body.length - 1, 0)}/${body.length}`,
        },
        body: new Uint8Array(body),
      });
      if (!done.ok) throw failed(done);
      const item = (await done.json()) as DriveItem;
      return { name: item.name, link: item.webUrl };
    },

    forget(accountId) {
      for (const key of folders.keys()) if (key.startsWith(`${accountId}:`)) folders.delete(key);
    },
  };
}
