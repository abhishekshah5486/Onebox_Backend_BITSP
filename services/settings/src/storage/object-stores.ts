import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { RestError, StorageSharedKeyCredential, ContainerClient } from '@azure/storage-blob';
import {
  S3_PRESETS,
  s3Endpoint,
  type AzureBlobCredentials,
  type KeyStorageConnect,
  type S3Credentials,
} from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import { resolvePublicHost } from '@onebox/net-guard';

const PROBE_KEY = '.onebox-connection-check';

// Where an Azure storage account's blobs are; tests point it at an emulator.
export type AzureEndpoint = (accountName: string) => string;
export const azureEndpoint: AzureEndpoint = (accountName) =>
  `https://${accountName}.blob.core.windows.net`;

export function s3Client(credentials: S3Credentials) {
  const endpoint = s3Endpoint(credentials);
  return new S3Client({
    region: credentials.region,
    ...(endpoint && { endpoint }),
    forcePathStyle: S3_PRESETS[credentials.preset].pathStyle,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
}

export function azureContainer(credentials: AzureBlobCredentials, endpoint = azureEndpoint) {
  const url = `${endpoint(credentials.accountName)}/${credentials.container}`;
  return new ContainerClient(
    url,
    new StorageSharedKeyCredential(credentials.accountName, credentials.accountKey),
  );
}

// How the account shows in the list, e.g. "receipts (Cloudflare R2)".
export const labelOf = (input: KeyStorageConnect) =>
  input.provider === 'S3'
    ? `${input.credentials.bucket} (${S3_PRESETS[input.credentials.preset].name})`
    : `${input.credentials.container} (${input.credentials.accountName})`;

export function s3Failure(err: unknown, bucket: string) {
  const name = err instanceof S3ServiceException ? err.name : '';
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken'].includes(name)) {
    return 'The storage service rejected these keys';
  }
  if (name === 'NoSuchBucket') return `There's no bucket called ${bucket}`;
  if (name === 'AccessDenied') return `These keys can't write to ${bucket}`;
  return `Couldn't reach the storage service: ${(err as Error).message.slice(0, 150)}`;
}

export function azureFailure(err: unknown, container: string) {
  if (err instanceof RestError) {
    if (err.code === 'ContainerNotFound') return `There's no container called ${container}`;
    if (err.statusCode === 403) return 'Azure rejected this account key';
  }
  return `Couldn't reach Azure: ${(err as Error).message.slice(0, 150)}`;
}

// Writes and deletes a small file, so keys that can only read are caught before saving.
export async function checkObjectStore(
  input: KeyStorageConnect,
  {
    allowPrivateHosts,
    endpoint = azureEndpoint,
  }: { allowPrivateHosts: boolean; endpoint?: AzureEndpoint },
) {
  const host =
    input.provider === 'S3'
      ? s3Endpoint(input.credentials)
      : endpoint(input.credentials.accountName);
  if (host) {
    const url = new URL(host);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ValidationError('The endpoint must start with http:// or https://');
    }
    await resolvePublicHost(url.hostname, { allowPrivate: allowPrivateHosts });
  }
  if (input.provider === 'S3') {
    const { bucket } = input.credentials;
    const client = s3Client(input.credentials);
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: PROBE_KEY, Body: 'ok' }), {
        abortSignal: AbortSignal.timeout(15_000),
      });
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: PROBE_KEY }));
    } catch (err) {
      throw new ValidationError(s3Failure(err, bucket), { code: 'STORAGE_CHECK_FAILED' });
    } finally {
      client.destroy();
    }
    return;
  }
  const { container } = input.credentials;
  try {
    const blob = azureContainer(input.credentials, endpoint).getBlockBlobClient(PROBE_KEY);
    await blob.upload('ok', 2, { abortSignal: AbortSignal.timeout(15_000) });
    await blob.delete();
  } catch (err) {
    throw new ValidationError(azureFailure(err, container), { code: 'STORAGE_CHECK_FAILED' });
  }
}
