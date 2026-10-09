import type { Logger } from '@onebox/logger';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { userPreferences, type PreferencesRow } from '../db/schema';

export type Preferences = Pick<
  PreferencesRow,
  | 'markSeenOnFetch'
  | 'autonomyMode'
  | 'signature'
  | 'timezone'
  | 'sidebarHidden'
  | 'chipsHidden'
  | 'inboxTabs'
>;

export const DEFAULT_PREFERENCES: Preferences = {
  markSeenOnFetch: true,
  autonomyMode: 'MANUAL',
  signature: null,
  timezone: 'UTC',
  // Like Gmail: the four tab categories stay out of the sidebar until asked for.
  sidebarHidden: ['category:social', 'category:updates', 'category:forums', 'category:promotions'],
  chipsHidden: [],
  inboxTabs: ['promotions', 'social', 'updates', 'forums'],
};

const toView = (row: PreferencesRow | undefined) => ({
  markSeenOnFetch: row?.markSeenOnFetch ?? DEFAULT_PREFERENCES.markSeenOnFetch,
  autonomyMode: row?.autonomyMode ?? DEFAULT_PREFERENCES.autonomyMode,
  signature: row?.signature ?? DEFAULT_PREFERENCES.signature,
  timezone: row?.timezone ?? DEFAULT_PREFERENCES.timezone,
  sidebarHidden: row?.sidebarHidden ?? DEFAULT_PREFERENCES.sidebarHidden,
  chipsHidden: row?.chipsHidden ?? DEFAULT_PREFERENCES.chipsHidden,
  inboxTabs: row?.inboxTabs ?? DEFAULT_PREFERENCES.inboxTabs,
  updatedAt: row?.updatedAt.toISOString() ?? null,
});

export type PreferencesView = ReturnType<typeof toView>;

export function createPreferencesService({
  db,
  logger,
}: {
  db: PostgresJsDatabase;
  logger: Logger;
}) {
  return {
    async get(userId: string): Promise<PreferencesView> {
      const [row] = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId));
      return toView(row);
    },

    async update(userId: string, changes: Partial<Preferences>): Promise<PreferencesView> {
      const [row] = await db
        .insert(userPreferences)
        .values({ userId, ...changes })
        .onConflictDoUpdate({ target: userPreferences.userId, set: changes })
        .returning();
      logger.info({ userId, fields: Object.keys(changes) }, 'preferences updated');
      return toView(row);
    },
  };
}

export type PreferencesService = ReturnType<typeof createPreferencesService>;
