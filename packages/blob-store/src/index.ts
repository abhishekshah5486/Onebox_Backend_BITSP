import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { z } from 'zod';

// Any S3-compatible store: SeaweedFS locally, S3 (or similar) when deployed.
export const blobConfigSchema = {
  BLOB_ENDPOINT: z.url().default('http://localhost:8333'),
  BLOB_REGION: z.string().min(1).default('us-east-1'),
  BLOB_BUCKET: z.string().min(3).default('onebox-attachments'),
  BLOB_ACCESS_KEY: z.string().min(1),
  BLOB_SECRET_KEY: z.string().min(1),
};

export interface BlobConfig {
  BLOB_ENDPOINT: string;
  BLOB_REGION: string;
  BLOB_BUCKET: string;
  BLOB_ACCESS_KEY: string;
  BLOB_SECRET_KEY: string;
}

export interface StoredBlob {
  body: Readable;
  contentType: string | undefined;
  sizeBytes: number | undefined;
}

const notFound = (err: unknown) => {
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return (
    status === 404 || (err as Error).name === 'NoSuchKey' || (err as Error).name === 'NotFound'
  );
};

export function createBlobStore(config: BlobConfig) {
  const bucket = config.BLOB_BUCKET;
  const s3 = new S3Client({
    endpoint: config.BLOB_ENDPOINT,
    region: config.BLOB_REGION,
    // Local stores serve buckets by path, not by subdomain.
    forcePathStyle: true,
    credentials: { accessKeyId: config.BLOB_ACCESS_KEY, secretAccessKey: config.BLOB_SECRET_KEY },
  });

  return {
    async ensureBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (err) {
        if (!notFound(err)) throw err;
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },

    async put(key: string, body: Buffer, contentType = 'application/octet-stream') {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },

    async exists(key: string) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        if (notFound(err)) return false;
        throw err;
      }
    },

    // Null when nothing is stored under the key.
    async get(key: string): Promise<StoredBlob | null> {
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return {
          body: object.Body as Readable,
          contentType: object.ContentType,
          sizeBytes: object.ContentLength,
        };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    async remove(key: string) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    close: () => s3.destroy(),
  };
}

export type BlobStore = ReturnType<typeof createBlobStore>;

// The same interface over a Map, for tests.
export function createMemoryBlobStore(): BlobStore {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    ensureBucket: async () => {},
    put: async (key, body, contentType = 'application/octet-stream') => {
      objects.set(key, { body, contentType });
    },
    exists: async (key) => objects.has(key),
    get: async (key) => {
      const object = objects.get(key);
      return object
        ? {
            body: Readable.from([object.body]),
            contentType: object.contentType,
            sizeBytes: object.body.length,
          }
        : null;
    },
    remove: async (key) => {
      objects.delete(key);
    },
    close: () => objects.clear(),
  };
}
