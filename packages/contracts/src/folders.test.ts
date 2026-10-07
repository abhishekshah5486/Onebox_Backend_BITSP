import { describe, expect, it } from 'vitest';
import { FOLDER_ROLES, folderRoleSchema } from './folders';

describe('folder roles', () => {
  it('lists the folders OneBox syncs', () => {
    expect(FOLDER_ROLES).toEqual(['inbox', 'sent', 'drafts', 'spam', 'trash']);
  });

  it('rejects unknown roles', () => {
    expect(folderRoleSchema.safeParse('archive').success).toBe(false);
  });
});
