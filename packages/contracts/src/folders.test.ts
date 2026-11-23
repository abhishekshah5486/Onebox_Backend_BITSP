import { describe, expect, it } from 'vitest';
import {
  categoriesOf,
  FOLDER_ROLES,
  folderRoleSchema,
  MAIL_CATEGORIES,
  MAIL_CATEGORY_DESCRIPTIONS,
  mailboxKey,
  mailboxRoleSchema,
  tabOf,
} from './folders';

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

  it('puts mail under its first tab category, else Primary', () => {
    expect(tabOf(['purchases', 'updates'])).toBe('updates');
    expect(tabOf(['travel'])).toBe('primary');
  });
});

describe('categories', () => {
  it("prefers Gmail's own categories, falling back to the AI's", () => {
    expect(categoriesOf({ categories: ['social'], aiCategories: ['updates'] })).toEqual(['social']);
    expect(categoriesOf({ categories: [], aiCategories: ['travel'] })).toEqual(['travel']);
    expect(categoriesOf({})).toEqual([]);
  });

  it('describes every category', () => {
    for (const category of MAIL_CATEGORIES) {
      expect(MAIL_CATEGORY_DESCRIPTIONS[category].length).toBeGreaterThan(20);
    }
  });
});
