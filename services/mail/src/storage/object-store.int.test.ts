import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { createLogger } from '@onebox/logger';
import { startAzurite, startS3, type TestAzurite, type TestObjectStore } from '@onebox/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { azureBlobUploader, s3Uploader } from './object-store';
import type { Uploader } from './uploader';

const logger = createLogger({ service: 'test', level: 'silent' });
let s3: TestObjectStore;
let azure: TestAzurite;

beforeAll(async () => {
  [s3, azure] = await Promise.all([startS3(), startAzurite()]);
  await new S3Client({
    region: 'us-east-1',
    endpoint: s3.url,
    forcePathStyle: true,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
  }).send(new CreateBucketCommand({ Bucket: 'receipts' }));
  await new ContainerClient(
    `${azure.endpoint(azure.accountName)}/files`,
    new StorageSharedKeyCredential(azure.accountName, azure.accountKey),
  ).create();
}, 240_000);

afterAll(async () => {
  await Promise.all([s3?.stop(), azure?.stop()]);
});

const file = (text: string) => ({
  name: 'bill.pdf',
  type: 'application/pdf',
  body: Buffer.from(text),
});

async function saveTwice(uploader: Uploader, token: string) {
  const folder = await uploader.folderAt(token, 'a', 'OneBox/Receipts');
  expect(folder).toBe('OneBox/Receipts');
  const first = await uploader.upload(token, folder, file('one'));
  const second = await uploader.upload(token, folder, file('two'));
  expect([first.name, second.name]).toEqual(['bill.pdf', 'bill (1).pdf']);
  expect(second.id).toBe('OneBox/Receipts/bill (1).pdf');
  // The shared link opens the file without keys.
  const link = await uploader.share(token, second);
  expect(await (await fetch(link)).text()).toBe('two');
  expect(await (await fetch(first.link)).text()).toBe('one');
}

describe('object store uploaders', () => {
  it('saves to an S3 bucket without overwriting, and shares a signed link', async () => {
    const token = JSON.stringify({
      preset: 'custom',
      endpoint: s3.url,
      region: 'us-east-1',
      bucket: 'receipts',
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    });
    await saveTwice(s3Uploader(logger), token);
  });

  it('saves to an Azure container the same way', async () => {
    const token = JSON.stringify({
      accountName: azure.accountName.toLowerCase().slice(0, 24),
      accountKey: azure.accountKey,
      container: 'files',
    });
    await saveTwice(
      azureBlobUploader(logger, (account) => azure.endpoint(account)),
      token,
    );
  });

  it('reports a failed save as the service not accepting the file', async () => {
    const token = JSON.stringify({
      preset: 'custom',
      endpoint: s3.url,
      region: 'us-east-1',
      bucket: 'receipts',
      accessKeyId: s3.accessKeyId,
      secretAccessKey: 'wrong',
    });
    await expect(s3Uploader(logger).upload(token, '', file('x'))).rejects.toMatchObject({
      message: 'The storage service did not accept the file',
    });
  });
});
