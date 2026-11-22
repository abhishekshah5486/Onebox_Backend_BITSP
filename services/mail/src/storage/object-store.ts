import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BlobSASPermissions,
  ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import {
  azureBlobCredentialsSchema,
  S3_PRESETS,
  s3CredentialsSchema,
  s3Endpoint,
  storagePathParts,
} from '@onebox/contracts';
import { ExternalServiceError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import type { Uploader } from './uploader';

// Signed links last as long as S3 and Azure allow for keys like these.
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

// " (1)", " (2)"… before the extension, as Drive and Dropbox name copies.
const numbered = (name: string, n: number) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
};

// Picks a key not yet taken, so a save never overwrites a file already there.
async function freeKey(folder: string, name: string, exists: (key: string) => Promise<boolean>) {
  const keyOf = (file: string) => (folder ? `${folder}/${file}` : file);
  for (let n = 0; n < 100; n += 1) {
    const file = n ? numbered(name, n) : name;
    if (!(await exists(keyOf(file)))) return { key: keyOf(file), name: file };
  }
  throw new ExternalServiceError(`Too many files called ${name} in this folder`);
}

const folderOf = (path: string) => storagePathParts(path).join('/');

// A bucket on S3 or a service that speaks its API. The "token" is the saved keys, as JSON.
export function s3Uploader(logger: Logger): Uploader {
  const open = (token: string) => {
    const credentials = s3CredentialsSchema.parse(JSON.parse(token));
    const endpoint = s3Endpoint(credentials);
    const client = new S3Client({
      region: credentials.region,
      ...(endpoint && { endpoint }),
      forcePathStyle: S3_PRESETS[credentials.preset].pathStyle,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
    return { client, bucket: credentials.bucket };
  };
  const signed = (client: S3Client, bucket: string, key: string) =>
    getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: LINK_TTL_SECONDS,
    });

  return {
    folderAt: async (_token, _accountId, path) => folderOf(path),

    async upload(token, folder, { name, type, body }) {
      const { client, bucket } = open(token);
      try {
        const free = await freeKey(folder, name, (key) =>
          client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(
            () => true,
            () => false,
          ),
        );
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: free.key, Body: body, ContentType: type }),
          { abortSignal: AbortSignal.timeout(120_000) },
        );
        return { id: free.key, name: free.name, link: await signed(client, bucket, free.key) };
      } catch (err) {
        if (err instanceof ExternalServiceError) throw err;
        logger.warn({ err: (err as Error).name }, 's3 upload failed');
        throw new ExternalServiceError('The storage service did not accept the file');
      } finally {
        client.destroy();
      }
    },

    async share(token, file) {
      const { client, bucket } = open(token);
      try {
        return await signed(client, bucket, file.id);
      } finally {
        client.destroy();
      }
    },

    forget: () => {},
  };
}

// A container in an Azure storage account. The "token" is the saved account key, as JSON.
export function azureBlobUploader(
  logger: Logger,
  endpoint = (accountName: string) => `https://${accountName}.blob.core.windows.net`,
): Uploader {
  const open = (token: string) => {
    const credentials = azureBlobCredentialsSchema.parse(JSON.parse(token));
    return new ContainerClient(
      `${endpoint(credentials.accountName)}/${credentials.container}`,
      new StorageSharedKeyCredential(credentials.accountName, credentials.accountKey),
    );
  };
  const signed = (container: ContainerClient, key: string) =>
    container.getBlobClient(key).generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + LINK_TTL_SECONDS * 1000),
    });

  return {
    folderAt: async (_token, _accountId, path) => folderOf(path),

    async upload(token, folder, { name, type, body }) {
      const container = open(token);
      try {
        const free = await freeKey(folder, name, (key) => container.getBlobClient(key).exists());
        await container.getBlockBlobClient(free.key).uploadData(body, {
          blobHTTPHeaders: { blobContentType: type },
          abortSignal: AbortSignal.timeout(120_000),
        });
        return { id: free.key, name: free.name, link: await signed(container, free.key) };
      } catch (err) {
        if (err instanceof ExternalServiceError) throw err;
        logger.warn({ err: (err as Error).name }, 'azure upload failed');
        throw new ExternalServiceError('Azure did not accept the file');
      }
    },

    share: async (token, file) => signed(open(token), file.id),
    forget: () => {},
  };
}
