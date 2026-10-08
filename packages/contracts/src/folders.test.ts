import { describe, expect, it } from 'vitest';
import { FOLDER_ROLES, folderRoleSchema, mailboxKey, mailboxRoleSchema } from './folders';

describe('folder roles', () => {
  it('lists the folders OneBox syncs', () => {
    expect(FOLDER_ROLES).toEqual(['inbox', 'sent', 'drafts', 'spam', 'trash', 'archive']);
  });

  it('rejects unknown roles', () => {
    expect(folderRoleSchema.safeParse('outbox').success).toBe(false);
    expect(folderRoleSchema.safeParse('label').success).toBe(false);
    expect(mailboxRoleSchema.safeParse('label').success).toBe(true);
  });

  it('keys folders by role and labels by path', () => {
    expect(mailboxKey('inbox', 'INBOX')).toBe('inbox');
    expect(mailboxKey('label', 'Work/Clients')).toBe('label:Work/Clients');
  });
});
