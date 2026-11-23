import { S3ServiceException } from '@aws-sdk/client-s3';
import { RestError } from '@azure/storage-blob';
import { describe, expect, it } from 'vitest';
import { azureFailure, s3Failure } from './object-stores';

const s3Error = (name: string) =>
  new S3ServiceException({ name, $fault: 'client', $metadata: {}, message: name });

describe('object store failures', () => {
  it('names what is wrong with an S3 bucket', () => {
    expect(s3Failure(s3Error('NoSuchBucket'), 'files')).toBe("There's no bucket called files");
    expect(s3Failure(s3Error('AccessDenied'), 'files')).toBe("These keys can't write to files");
    expect(s3Failure(s3Error('SignatureDoesNotMatch'), 'files')).toBe(
      'The storage service rejected these keys',
    );
    expect(s3Failure(new Error('getaddrinfo ENOTFOUND'), 'files')).toMatch(/^Couldn't reach/);
  });

  it('names what is wrong with an Azure container', () => {
    const missing = new RestError('no', { statusCode: 404, code: 'ContainerNotFound' });
    expect(azureFailure(missing, 'files')).toBe("There's no container called files");
    expect(azureFailure(new RestError('no', { statusCode: 403 }), 'files')).toBe(
      'Azure rejected this account key',
    );
  });
});
