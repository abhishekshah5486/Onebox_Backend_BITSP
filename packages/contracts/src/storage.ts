import { z } from 'zod';

// A folder path in cloud storage, e.g. "OneBox/Receipts/2026"; empty means the top level.
// Stray and doubled slashes are dropped, so " /OneBox//Receipts/ " becomes "OneBox/Receipts".
export const storagePathSchema = z
  .string()
  .max(500)
  .transform((path) =>
    path
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
      .join('/'),
  )
  .refine((path) => path.split('/').length <= 10, 'Use at most 10 folders')
  .refine(
    (path) => path.split('/').every((part) => part.length <= 100),
    'Folder names can be at most 100 characters',
  );

export const storagePathParts = (path: string) => path.split('/').filter(Boolean);

// Cloud storage services attachments can be saved to: some sign in with OAuth, the object
// stores connect with keys.
export const OAUTH_STORAGE_PROVIDERS = ['GOOGLE_DRIVE', 'ONEDRIVE', 'DROPBOX'] as const;
export const KEY_STORAGE_PROVIDERS = ['S3', 'AZURE_BLOB'] as const;
export const STORAGE_PROVIDERS = [...OAUTH_STORAGE_PROVIDERS, ...KEY_STORAGE_PROVIDERS] as const;
export type StorageProviderId = (typeof STORAGE_PROVIDERS)[number];
export type OAuthStorageProviderId = (typeof OAUTH_STORAGE_PROVIDERS)[number];
export type KeyStorageProviderId = (typeof KEY_STORAGE_PROVIDERS)[number];

export const isKeyStorage = (id: StorageProviderId): id is KeyStorageProviderId =>
  (KEY_STORAGE_PROVIDERS as readonly string[]).includes(id);

// Services that speak the S3 API, and where each one's endpoint is. {region} and {account}
// are filled in from the form.
export const S3_PRESETS = {
  aws: { name: 'Amazon S3', endpoint: null, region: 'us-east-1', pathStyle: false },
  gcs: {
    name: 'Google Cloud Storage',
    endpoint: 'https://storage.googleapis.com',
    region: 'auto',
    pathStyle: false,
  },
  r2: {
    name: 'Cloudflare R2',
    endpoint: 'https://{account}.r2.cloudflarestorage.com',
    region: 'auto',
    pathStyle: false,
  },
  wasabi: {
    name: 'Wasabi',
    endpoint: 'https://s3.{region}.wasabisys.com',
    region: 'us-east-1',
    pathStyle: false,
  },
  b2: {
    name: 'Backblaze B2',
    endpoint: 'https://s3.{region}.backblazeb2.com',
    region: 'us-west-004',
    pathStyle: false,
  },
  spaces: {
    name: 'DigitalOcean Spaces',
    endpoint: 'https://{region}.digitaloceanspaces.com',
    region: 'nyc3',
    pathStyle: false,
  },
  custom: { name: 'S3 compatible', endpoint: null, region: 'us-east-1', pathStyle: true },
} as const;
export type S3Preset = keyof typeof S3_PRESETS;

const plain = z.string().trim().min(1).max(200);
export const s3CredentialsSchema = z.object({
  preset: z.enum(Object.keys(S3_PRESETS) as [S3Preset, ...S3Preset[]]),
  bucket: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
      'Bucket names are 3-63 lowercase letters, digits, dots or dashes',
    ),
  region: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,40}$/, 'Region looks like us-east-1'),
  // Cloudflare's account id, for R2.
  account: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{32}$/i, 'The account id is 32 characters')
    .optional(),
  // Only for "custom": the service's own address.
  endpoint: z.url().optional(),
  accessKeyId: plain,
  secretAccessKey: z.string().trim().min(1).max(500),
});
export type S3Credentials = z.infer<typeof s3CredentialsSchema>;

export const azureBlobCredentialsSchema = z.object({
  accountName: z
    .string()
    .trim()
    .regex(/^[a-z0-9]{3,24}$/, 'Storage account names are 3-24 lowercase letters or digits'),
  accountKey: z.string().trim().min(1).max(500),
  container: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/,
      'Container names are 3-63 lowercase letters, digits or dashes',
    ),
});
export type AzureBlobCredentials = z.infer<typeof azureBlobCredentialsSchema>;

export const keyStorageConnectSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('S3'), credentials: s3CredentialsSchema }),
  z.object({ provider: z.literal('AZURE_BLOB'), credentials: azureBlobCredentialsSchema }),
]);
export type KeyStorageConnect = z.infer<typeof keyStorageConnectSchema>;

// The S3 endpoint a preset points at, or null for AWS's own.
export function s3Endpoint(credentials: S3Credentials): string | null {
  const preset = S3_PRESETS[credentials.preset];
  if (credentials.preset === 'custom') return credentials.endpoint ?? null;
  return preset.endpoint
    ? preset.endpoint
        .replace('{region}', credentials.region)
        .replace('{account}', credentials.account ?? '')
    : null;
}
