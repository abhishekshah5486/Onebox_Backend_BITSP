import { z } from 'zod';

// A folder path under My Drive, e.g. "OneBox/Receipts/2026"; empty means the top level.
// Stray and doubled slashes are dropped, so " /OneBox//Receipts/ " becomes "OneBox/Receipts".
export const drivePathSchema = z
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

export const drivePathParts = (path: string) => path.split('/').filter(Boolean);
