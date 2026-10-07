import { boolean, index, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const settingsSchema = pgSchema('settings');

export const AUTONOMY_MODES = ['MANUAL', 'SUGGEST', 'SEMI', 'AUTO'] as const;
export const INTEGRATION_TYPES = ['SLACK', 'WEBHOOK'] as const;
export const INTEGRATION_EVENTS = [
  'email.received',
  'email.classified',
  'email.interested',
  'account.degraded',
] as const;

export const autonomyModeEnum = settingsSchema.enum('autonomy_mode', AUTONOMY_MODES);
export const integrationTypeEnum = settingsSchema.enum('integration_type', INTEGRATION_TYPES);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const userPreferences = settingsSchema.table('user_preferences', {
  userId: uuid('user_id').primaryKey(),
  markSeenOnFetch: boolean('mark_seen_on_fetch').notNull().default(true),
  autonomyMode: autonomyModeEnum('autonomy_mode').notNull().default('MANUAL'),
  signature: text('signature'),
  timezone: text('timezone').notNull().default('UTC'),
  ...timestamps,
});

export const integrations = settingsSchema.table(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    type: integrationTypeEnum('type').notNull(),
    name: text('name').notNull(),
    // Webhook URLs and signing secrets are credentials, so the whole config is encrypted.
    configEncrypted: text('config_encrypted').notNull(),
    targetHint: text('target_hint').notNull(),
    events: text('events').array().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastError: text('last_error'),
    ...timestamps,
  },
  (table) => [
    unique('integrations_user_name_unique').on(table.userId, table.name),
    index('integrations_user_idx').on(table.userId),
  ],
);

export type IntegrationRow = typeof integrations.$inferSelect;
export type PreferencesRow = typeof userPreferences.$inferSelect;
