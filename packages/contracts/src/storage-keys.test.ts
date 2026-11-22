import { describe, expect, it } from 'vitest';
import { keyStorageConnectSchema, s3Endpoint, s3CredentialsSchema } from './storage';

const s3 = (extra: Record<string, unknown>) =>
  s3CredentialsSchema.parse({
    preset: 'aws',
    bucket: 'onebox-files',
    region: 'eu-west-1',
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
    ...extra,
  });

describe('key storage', () => {
  it('points each S3 preset at its endpoint', () => {
    expect(s3Endpoint(s3({}))).toBeNull();
    expect(s3Endpoint(s3({ preset: 'gcs' }))).toBe('https://storage.googleapis.com');
    expect(s3Endpoint(s3({ preset: 'wasabi', region: 'eu-central-1' }))).toBe(
      'https://s3.eu-central-1.wasabisys.com',
    );
    expect(s3Endpoint(s3({ preset: 'r2', region: 'auto', account: 'a'.repeat(32) }))).toBe(
      `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
    );
    expect(s3Endpoint(s3({ preset: 'custom', endpoint: 'https://minio.example.com' }))).toBe(
      'https://minio.example.com',
    );
  });

  it('refuses names that could end up somewhere else in a URL', () => {
    expect(() => s3({ bucket: 'evil.com/x#' })).toThrow();
    expect(() => s3({ region: 'us-east-1.evil.com/' })).toThrow();
    const azure = keyStorageConnectSchema.safeParse({
      provider: 'AZURE_BLOB',
      credentials: { accountName: 'evil.com', accountKey: 'k', container: 'files' },
    });
    expect(azure.success).toBe(false);
  });
});
