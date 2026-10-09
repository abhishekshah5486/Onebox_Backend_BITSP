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

// Cloud storage services attachments can be saved to; Dropbox is planned.
export const STORAGE_PROVIDERS = ['GOOGLE_DRIVE', 'ONEDRIVE'] as const;
export type StorageProviderId = (typeof STORAGE_PROVIDERS)[number];
