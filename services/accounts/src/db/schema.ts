import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const accountsSchema = pgSchema('accounts');

export const PROVIDERS = ['GMAIL', 'OUTLOOK', 'ICLOUD', 'YAHOO', 'IMAP'] as const;
export const ACCOUNT_STATUSES = [
  'CONNECTED',
  'AUTH_FAILED',
  'UNREACHABLE',
  'TLS_ERROR',
  'DISABLED',
] as const;

export const providerEnum = accountsSchema.enum('provider', PROVIDERS);
export const accountStatusEnum = accountsSchema.enum('account_status', ACCOUNT_STATUSES);

export const emailAccounts = accountsSchema.table(
  'email_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Owned by the identity service; referenced by id only, never joined across schemas.
    userId: uuid('user_id').notNull(),
    provider: providerEnum('provider').notNull(),
    emailAddress: text('email_address').notNull(),
    displayName: text('display_name'),
    imapHost: text('imap_host').notNull(),
    imapPort: integer('imap_port').notNull(),
    imapTls: boolean('imap_tls').notNull(),
    smtpHost: text('smtp_host'),
    smtpPort: integer('smtp_port'),
    smtpTls: boolean('smtp_tls'),
    username: text('username').notNull(),
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    status: accountStatusEnum('status').notNull().default('CONNECTED'),
    lastError: text('last_error'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    syncState: jsonb('sync_state').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('email_accounts_user_email_unique').on(table.userId, table.emailAddress),
    index('email_accounts_user_idx').on(table.userId),
  ],
);

export type EmailAccountRow = typeof emailAccounts.$inferSelect;
