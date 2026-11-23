import { z } from 'zod';

// Logical folders OneBox syncs; each maps to a provider-specific IMAP path per account.
// Archive is Gmail's All Mail, or the provider's Archive folder.
export const FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'spam', 'trash', 'archive'] as const;

export type FolderRole = (typeof FOLDER_ROLES)[number];

export const folderRoleSchema = z.enum(FOLDER_ROLES);

// Any other folder the user made: a Gmail label, or a plain folder elsewhere.
export const LABEL_ROLE = 'label';

export const mailboxRoleSchema = z.enum([...FOLDER_ROLES, LABEL_ROLE]);

export type MailboxRole = z.infer<typeof mailboxRoleSchema>;

// Folders are known by role; labels by their path, since an account can have many.
export const mailboxKey = (role: MailboxRole, path: string) =>
  role === LABEL_ROLE ? `label:${path}` : role;

// Gmail's inbox tabs. They can be read over IMAP but not changed, so they are view-only.
export const GMAIL_CATEGORIES = ['primary', 'social', 'promotions', 'updates', 'forums'] as const;

export type GmailCategory = (typeof GMAIL_CATEGORIES)[number];

export const gmailCategorySchema = z.enum(GMAIL_CATEGORIES);

// Every category Gmail can tag mail with. The four tabs plus Purchases and Travel, which Gmail
// adds on top of a tab, so one message can carry several.
export const MAIL_CATEGORIES = [
  'social',
  'promotions',
  'updates',
  'forums',
  'purchases',
  'travel',
] as const;

export type MailCategory = (typeof MAIL_CATEGORIES)[number];

export const mailCategorySchema = z.enum(MAIL_CATEGORIES);

// What each category holds, as Gmail describes it; the AI fills categories in from these where
// Gmail gives none (Gmail stopped tagging mail over IMAP in February 2026).
export const MAIL_CATEGORY_DESCRIPTIONS: Record<MailCategory, string> = {
  social:
    'Messages from social networks, media-sharing sites, dating services and other social sites.',
  promotions: 'Deals, offers, sales, newsletters and other marketing email from brands.',
  updates:
    'Automatic notifications from services and accounts: confirmations, alerts, statements, bills, security notices.',
  forums: 'Messages from online groups, discussion boards and mailing lists.',
  purchases: 'Orders, receipts, invoices, and shipping or delivery updates for things bought.',
  travel:
    'Flight, hotel, train, car rental and other trip bookings, itineraries and check-in reminders.',
};

// The categories a message shows under: Gmail's own when it gave any, else the AI's.
export const categoriesOf = (doc: {
  categories?: readonly MailCategory[] | null;
  aiCategories?: readonly MailCategory[] | null;
}): MailCategory[] => [...(doc.categories?.length ? doc.categories : (doc.aiCategories ?? []))];

// The inbox tab a message shows under: its first tab category, else Primary.
export const tabOf = (categories: readonly string[]): GmailCategory =>
  GMAIL_CATEGORIES.find((tab) => tab !== 'primary' && categories.includes(tab)) ?? 'primary';
