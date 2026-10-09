import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Not "auth": Supabase reserves that schema for its own Auth service.
export const identitySchema = pgSchema('identity');

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = identitySchema.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...timestamps,
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// A family is one login session; reusing a rotated token revokes the whole family.
export const refreshTokens = identitySchema.table(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ip: text('ip'),
    ...timestamps,
  },
  (table) => [
    index('refresh_tokens_family_idx').on(table.familyId),
    index('refresh_tokens_user_active_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export const signingKeys = identitySchema.table('signing_keys', {
  kid: text('kid').primaryKey(),
  publicJwk: jsonb('public_jwk').notNull(),
  privateJwkEncrypted: text('private_jwk_encrypted').notNull(),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});
