import { z } from 'zod';

// Logical folders OneBox syncs; each maps to a provider-specific IMAP path per account.
export const FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'spam', 'trash'] as const;

export type FolderRole = (typeof FOLDER_ROLES)[number];

export const folderRoleSchema = z.enum(FOLDER_ROLES);
